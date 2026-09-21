"""Invite-only authentication and session management.

The whole app is gated behind a login. Registration is *invite-only*:

  1. A visitor submits an invite request (email + name + optional message).
  2. An admin reviews pending requests in the dashboard and approves/denies.
  3. Approving an invite marks the email as allowed to register.
  4. The invited person then sets a password (register) and can sign in.

A default admin (email/username/password from settings) is seeded on first run
so there is always at least one account that can approve invites.

Implementation notes:
  * Uses the same SQLite file as job history (``workspace/sessions.db``) with
    three extra tables: ``users``, ``invites``, ``auth_sessions``.
  * Passwords are hashed with PBKDF2-HMAC-SHA256 (stdlib only, no new deps).
  * Sessions are opaque random tokens stored server-side and referenced by a
    signed cookie. Cookie auth is used (not bearer headers) so ``EventSource``
    SSE streams and ``<img>/<video>`` artifact requests are authenticated too.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass
from typing import Optional

from .config import get_settings
from .db import _connect  # reuse the shared connection + lock
from .db import _lock
from .logging_setup import log

COOKIE_NAME = "ms_sid"
_PBKDF2_ROUNDS = 120_000
_seeded = False
_seed_lock = threading.Lock()

VALID_ROLES = frozenset({"user", "admin"})


# --------------------------------------------------------------------- schema --

def _ensure_schema() -> None:
    conn = _connect()
    with _lock:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id            TEXT PRIMARY KEY,
                email         TEXT UNIQUE NOT NULL,
                username      TEXT,
                password_hash TEXT NOT NULL,
                role          TEXT NOT NULL DEFAULT 'user',
                created_at    REAL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS invites (
                id          TEXT PRIMARY KEY,
                email       TEXT NOT NULL,
                name        TEXT,
                message     TEXT,
                status      TEXT NOT NULL DEFAULT 'pending',
                created_at  REAL,
                decided_at  REAL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS auth_sessions (
                token       TEXT PRIMARY KEY,
                user_id     TEXT NOT NULL,
                created_at  REAL,
                expires_at  REAL
            )
            """
        )
        conn.commit()


# ------------------------------------------------------------- password utils --

def hash_password(password: str, salt: Optional[str] = None) -> str:
    """Return a ``pbkdf2$rounds$salt$hexdigest`` string."""
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), _PBKDF2_ROUNDS
    )
    return f"pbkdf2${_PBKDF2_ROUNDS}${salt}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, rounds_s, salt, digest = stored.split("$", 3)
        rounds = int(rounds_s)
    except (ValueError, AttributeError):
        return False
    dk = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), rounds
    )
    return hmac.compare_digest(dk.hex(), digest)


# ------------------------------------------------------------------- seeding --

def seed_admin() -> None:
    """Create / sync the bootstrap admin from ``AUTH_ADMIN_*`` env settings.

    ``.env`` is the source of truth: on every startup the configured email is
    ensured to exist as ``admin`` with the username + password from settings.
    Change credentials by editing ``.env`` and restarting the server.

    Side effects on change:
      * password / username update → revoke that user's sessions
      * AUTH_ADMIN_EMAIL change → demote the previous bootstrap email (if any)
    """
    global _seeded
    with _seed_lock:
        if _seeded:
            return
        _ensure_schema()
        s = get_settings()
        email = (s.auth_admin_email or "").strip().lower()
        username = (s.auth_admin_username or "admin").strip() or "admin"
        password = s.auth_admin_password or ""
        if not email or not password:
            log.bind(task="auth").warning(
                "AUTH_ADMIN_EMAIL / AUTH_ADMIN_PASSWORD not set — skipping admin seed"
            )
            _seeded = True
            return

        from .config import WORKSPACE_DIR

        marker = WORKSPACE_DIR / ".bootstrap_admin_email"
        prev_email = ""
        try:
            if marker.is_file():
                prev_email = marker.read_text(encoding="utf-8").strip().lower()
        except Exception:
            prev_email = ""

        pw_hash = hash_password(password)
        conn = _connect()
        with _lock:
            # If bootstrap email rotated, demote the previous env-managed admin
            if prev_email and prev_email != email:
                old = conn.execute(
                    "SELECT id, role FROM users WHERE email = ?", (prev_email,)
                ).fetchone()
                if old and old["role"] == "admin":
                    conn.execute(
                        "UPDATE users SET role = 'user' WHERE id = ?", (old["id"],)
                    )
                    conn.execute(
                        "DELETE FROM auth_sessions WHERE user_id = ?", (old["id"],)
                    )
                    log.bind(task="auth").info(
                        f"demoted previous bootstrap admin {prev_email} after AUTH_ADMIN_EMAIL change"
                    )

            row = conn.execute(
                "SELECT id, username, password_hash, role FROM users WHERE email = ?",
                (email,),
            ).fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO users (id, email, username, password_hash, role, created_at) "
                    "VALUES (?, ?, ?, ?, 'admin', ?)",
                    (
                        secrets.token_hex(8),
                        email,
                        username,
                        pw_hash,
                        time.time(),
                    ),
                )
                conn.commit()
                log.bind(task="auth").info(f"seeded bootstrap admin {email} from env")
            else:
                pw_changed = not verify_password(password, row["password_hash"] or "")
                needs = (
                    (row["username"] or "") != username
                    or row["role"] != "admin"
                    or pw_changed
                )
                if needs:
                    conn.execute(
                        "UPDATE users SET username = ?, password_hash = ?, role = 'admin' "
                        "WHERE email = ?",
                        (username, pw_hash, email),
                    )
                    conn.execute(
                        "DELETE FROM auth_sessions WHERE user_id = ?", (row["id"],)
                    )
                    conn.commit()
                    log.bind(task="auth").info(
                        f"synced bootstrap admin {email} credentials from env"
                    )

        try:
            WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
            marker.write_text(email + "\n", encoding="utf-8")
        except Exception as e:
            log.bind(task="auth").warning(f"could not write bootstrap email marker: {e}")

        _seeded = True


# --------------------------------------------------------------------- users --

@dataclass
class User:
    id: str
    email: str
    username: str
    role: str

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    def public(self) -> dict:
        return {"id": self.id, "email": self.email, "username": self.username, "role": self.role}


def _row_to_user(row: sqlite3.Row) -> User:
    return User(id=row["id"], email=row["email"], username=row["username"] or "", role=row["role"])


def get_user_by_email(email: str) -> Optional[User]:
    conn = _connect()
    with _lock:
        row = conn.execute(
            "SELECT * FROM users WHERE email = ?", (email.strip().lower(),)
        ).fetchone()
    return _row_to_user(row) if row else None


def _get_user_row(email: str) -> Optional[sqlite3.Row]:
    conn = _connect()
    with _lock:
        return conn.execute(
            "SELECT * FROM users WHERE email = ?", (email.strip().lower(),)
        ).fetchone()


def get_user_by_id(user_id: str) -> Optional[User]:
    conn = _connect()
    with _lock:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return _row_to_user(row) if row else None


def list_users() -> list[dict]:
    conn = _connect()
    with _lock:
        rows = conn.execute(
            "SELECT id, email, username, role, created_at FROM users ORDER BY created_at ASC"
        ).fetchall()
    return [dict(r) for r in rows]


def list_admin_users() -> list[dict]:
    """Registered users plus approved invites that have not finished registration."""
    conn = _connect()
    with _lock:
        user_rows = conn.execute(
            "SELECT id, email, username, role, created_at FROM users ORDER BY created_at ASC"
        ).fetchall()
        users: list[dict] = []
        registered_emails: set[str] = set()
        for row in user_rows:
            d = dict(row)
            d["status"] = "active"
            users.append(d)
            registered_emails.add(d["email"])
        invite_rows = conn.execute(
            "SELECT id, email, name, created_at, decided_at FROM invites "
            "WHERE status = 'approved' ORDER BY decided_at ASC, created_at ASC"
        ).fetchall()
        for row in invite_rows:
            email = row["email"]
            if email in registered_emails:
                continue
            users.append({
                "id": f"invite:{row['id']}",
                "email": email,
                "username": row["name"] or "",
                "role": "user",
                "created_at": row["decided_at"] or row["created_at"],
                "status": "invited",
            })
    return users


def count_admins() -> int:
    conn = _connect()
    with _lock:
        row = conn.execute(
            "SELECT COUNT(*) c FROM users WHERE role = 'admin'"
        ).fetchone()
    return int(row["c"] if row else 0)


def destroy_user_sessions(user_id: str) -> None:
    conn = _connect()
    with _lock:
        conn.execute("DELETE FROM auth_sessions WHERE user_id = ?", (user_id,))
        conn.commit()


def update_user(
    user_id: str,
    *,
    role: Optional[str] = None,
    username: Optional[str] = None,
) -> Optional[User]:
    """Update role and/or display name. Returns the updated user."""
    conn = _connect()
    sets: list[str] = []
    params: list = []
    if role is not None:
        role = role.strip().lower()
        if role not in VALID_ROLES:
            raise ValueError(f"Invalid role. Use one of: {', '.join(sorted(VALID_ROLES))}")
        sets.append("role = ?")
        params.append(role)
    if username is not None:
        sets.append("username = ?")
        params.append(username.strip()[:60])
    if not sets:
        return get_user_by_id(user_id)
    params.append(user_id)
    with _lock:
        cur = conn.execute(
            f"UPDATE users SET {', '.join(sets)} WHERE id = ?",
            params,
        )
        conn.commit()
        if cur.rowcount == 0:
            return None
    return get_user_by_id(user_id)


def delete_user(user_id: str) -> bool:
    """Remove a user and invalidate their sessions."""
    conn = _connect()
    with _lock:
        cur = conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.execute("DELETE FROM auth_sessions WHERE user_id = ?", (user_id,))
        conn.commit()
        return cur.rowcount > 0


def create_user(email: str, username: str, password: str, role: str = "user") -> User:
    email = email.strip().lower()
    uid = secrets.token_hex(8)
    conn = _connect()
    with _lock:
        conn.execute(
            "INSERT INTO users (id, email, username, password_hash, role, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (uid, email, username, hash_password(password), role, time.time()),
        )
        conn.commit()
    return User(id=uid, email=email, username=username, role=role)


def authenticate(identifier: str, password: str) -> Optional[User]:
    """Authenticate by email OR username + password."""
    ident = (identifier or "").strip().lower()
    conn = _connect()
    with _lock:
        row = conn.execute(
            "SELECT * FROM users WHERE email = ? OR lower(username) = ?",
            (ident, ident),
        ).fetchone()
    if not row:
        return None
    if not verify_password(password, row["password_hash"]):
        return None
    return _row_to_user(row)


# ------------------------------------------------------------------- invites --

def create_invite_request(email: str, name: str = "", message: str = "") -> dict:
    email = email.strip().lower()
    conn = _connect()
    with _lock:
        # If there is already a pending request for this email, reuse it.
        existing = conn.execute(
            "SELECT * FROM invites WHERE email = ? AND status = 'pending'", (email,)
        ).fetchone()
        if existing:
            return dict(existing)
        iid = secrets.token_hex(8)
        conn.execute(
            "INSERT INTO invites (id, email, name, message, status, created_at) "
            "VALUES (?, ?, ?, ?, 'pending', ?)",
            (iid, email, name, message, time.time()),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM invites WHERE id = ?", (iid,)).fetchone()
    return dict(row)


def list_invites(status: Optional[str] = None) -> list[dict]:
    conn = _connect()
    with _lock:
        if status:
            rows = conn.execute(
                "SELECT * FROM invites WHERE status = ? ORDER BY created_at DESC", (status,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM invites ORDER BY created_at DESC"
            ).fetchall()
    return [dict(r) for r in rows]


def decide_invite(invite_id: str, approve: bool) -> Optional[dict]:
    conn = _connect()
    status = "approved" if approve else "denied"
    with _lock:
        conn.execute(
            "UPDATE invites SET status = ?, decided_at = ? WHERE id = ?",
            (status, time.time(), invite_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM invites WHERE id = ?", (invite_id,)).fetchone()
    return dict(row) if row else None


def mark_invite_registered(email: str) -> None:
    """Mark approved invites for this email as fully registered."""
    email = email.strip().lower()
    conn = _connect()
    with _lock:
        conn.execute(
            "UPDATE invites SET status = 'registered' WHERE email = ? AND status = 'approved'",
            (email,),
        )
        conn.commit()


def revoke_approved_invite(invite_id: str) -> bool:
    """Cancel an approved invite before the person registers."""
    conn = _connect()
    with _lock:
        cur = conn.execute(
            "UPDATE invites SET status = 'revoked', decided_at = ? "
            "WHERE id = ? AND status = 'approved'",
            (time.time(), invite_id),
        )
        conn.commit()
        return cur.rowcount > 0


# Terminal invite statuses that are safe to purge from the admin list / DB.
CLEARABLE_INVITE_STATUSES = frozenset({"revoked", "denied", "registered"})


def delete_invite(invite_id: str) -> bool:
    """Permanently remove one invite row (any status)."""
    conn = _connect()
    with _lock:
        cur = conn.execute("DELETE FROM invites WHERE id = ?", (invite_id,))
        conn.commit()
        return cur.rowcount > 0


def clear_old_invites(
    statuses: list[str] | None = None,
) -> dict:
    """Delete settled invite rows (revoked / denied / registered by default).

    Pending and approved invites are never removed by this helper.
    """
    wanted = {
        str(s).strip().lower()
        for s in (statuses or list(CLEARABLE_INVITE_STATUSES))
        if str(s).strip()
    }
    wanted &= CLEARABLE_INVITE_STATUSES
    if not wanted:
        return {"deleted": 0, "statuses": []}
    conn = _connect()
    with _lock:
        placeholders = ",".join("?" for _ in wanted)
        cur = conn.execute(
            f"DELETE FROM invites WHERE status IN ({placeholders})",
            tuple(sorted(wanted)),
        )
        conn.commit()
        return {"deleted": int(cur.rowcount or 0), "statuses": sorted(wanted)}


def is_email_approved(email: str) -> bool:
    """True if the email has an approved (unused) invite or is already a user."""
    email = email.strip().lower()
    if get_user_by_email(email):
        return False  # already registered
    conn = _connect()
    with _lock:
        row = conn.execute(
            "SELECT id FROM invites WHERE email = ? AND status = 'approved' "
            "ORDER BY created_at DESC LIMIT 1",
            (email,),
        ).fetchone()
    return row is not None


# ------------------------------------------------------------------ sessions --

def create_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    s = get_settings()
    expires = (
        now + s.auth_session_hours * 3600
        if s.auth_session_persistent and s.auth_session_hours > 0
        else None
    )
    conn = _connect()
    with _lock:
        conn.execute(
            "INSERT INTO auth_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token, user_id, now, expires),
        )
        conn.commit()
    return token


def destroy_session(token: str) -> None:
    conn = _connect()
    with _lock:
        conn.execute("DELETE FROM auth_sessions WHERE token = ?", (token,))
        conn.commit()


def user_for_session(token: Optional[str]) -> Optional[User]:
    if not token:
        return None
    conn = _connect()
    with _lock:
        row = conn.execute(
            "SELECT user_id, expires_at FROM auth_sessions WHERE token = ?", (token,)
        ).fetchone()
    if not row:
        return None
    if row["expires_at"] and row["expires_at"] < time.time():
        destroy_session(token)
        return None
    return get_user_by_id(row["user_id"])
