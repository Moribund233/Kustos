"""配置密钥的静态加密（AES-256-GCM，密文落库）。

API key 由后台录入后**密文保存**（``config_secrets`` 表），运行期解密进内存使用
——永不回显、永不入日志。

主密钥解析顺序：

1. ``KUSTOS_CONFIG_MASTER_KEY``（专用主密钥，生产推荐——与其它用途隔离）；
2. 缺省回落 ``KUSTOS_SECURITY_SECRET_KEY`` 经 **HKDF 域分隔派生**：
   HKDF 的 ``info`` 与 JWT 签名完全不同，**即使源字符串相同也不共享密钥
   材料**，避免「JWT 密钥泄露连带全部 provider key」的双祸。

安全性质：

- AES-256-GCM（AEAD）：机密性 + 完整性 + 不可伪造，密文被篡改解密即失败；
- 每次加密随机 12 字节 nonce；
- **AAD 绑定 ``section:name``**：密文在表内搬移（如把 agent 的 key 粘到
  embedding 字段）解密失败，防用途混淆；
- 密文格式 ``enc:v1:<urlsafe_b64(nonce||ct||tag)>``：版本前缀支持后续
  主密钥轮换/算法迁移（读到非此前缀一律拒绝，不透传明文）。

异常：本模块只抛 :class:`ConfigSecretError`（消息只含失败原因类型，
**不含明文/密文**）；HTTP 层由服务侧转 ``config_secret_decrypt_failed``。
"""
from __future__ import annotations

import base64
import os
import threading
from typing import Optional

#: 密文前缀（版本化：未来轮换时新写入用 v2，读侧兼容多版本）
PREFIX = "enc:v1:"

_SALT = b"kustos-config-enc"
_INFO_V1 = b"kustos-config-secret-v1"
_NONCE_LEN = 12
_KEY_LEN = 32

_master: Optional[bytes] = None
_lock = threading.Lock()


class ConfigSecretError(RuntimeError):
    """密钥加密/解密失败（主密钥缺失、密文损坏/篡改、AAD 不匹配）"""


def _try_b64_32(value: str) -> Optional[bytes]:
    """若 ``value`` 是 urlsafe-b64 编码的 32 字节则解码返回，否则 ``None``"""
    try:
        raw = base64.urlsafe_b64decode(value.encode())
        return raw if len(raw) == _KEY_LEN else None
    except Exception:  # noqa: BLE001 — 不是 b64 就是原串
        return None


def _derive_master() -> bytes:
    dedicated = (os.environ.get("KUSTOS_CONFIG_MASTER_KEY") or "").strip()
    if dedicated:
        raw = _try_b64_32(dedicated) or dedicated.encode("utf-8")
    else:
        secret = (os.environ.get("KUSTOS_SECURITY_SECRET_KEY") or "").strip()
        if not secret:
            raise ConfigSecretError(
                "主密钥未配置：需要 KUSTOS_CONFIG_MASTER_KEY 或 KUSTOS_SECURITY_SECRET_KEY"
            )
        raw = secret.encode("utf-8")
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    return HKDF(
        algorithm=hashes.SHA256(), length=_KEY_LEN, salt=_SALT, info=_INFO_V1
    ).derive(raw)


def _master_key() -> bytes:
    global _master
    if _master is not None:
        return _master
    with _lock:
        if _master is None:
            _master = _derive_master()
    return _master


def _aad(section: str, name: str) -> bytes:
    return f"{section}:{name}".encode("utf-8")


def encrypt_secret(plaintext: str, *, section: str, name: str) -> str:
    """加密为 ``enc:v1:...`` 密文。

    Args:
        plaintext: 明文 key（只在调用栈内存活，不落日志）
        section: 配置节（如 ``agent`` / ``search``）——进 AAD
        name: 密钥字段名（如 ``api_key``）——进 AAD

    Raises:
        ConfigSecretError: 明文为空 / 主密钥不可用
    """
    if not isinstance(plaintext, str) or not plaintext:
        raise ConfigSecretError("明文为空，拒绝加密")
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = os.urandom(_NONCE_LEN)
    ct = AESGCM(_master_key()).encrypt(
        nonce, plaintext.encode("utf-8"), _aad(section, name)
    )
    return PREFIX + base64.urlsafe_b64encode(nonce + ct).decode("ascii")


def decrypt_secret(token: str, *, section: str, name: str) -> str:
    """解密 ``enc:v1:...`` 密文，返回明文。

    Raises:
        ConfigSecretError: 非密文格式（拒绝明文透传）/ 密文损坏 / AAD 不匹配 /
            主密钥不可用。消息**不含**明文与密文。
    """
    if not isinstance(token, str) or not token.startswith(PREFIX):
        raise ConfigSecretError("值不是本模块产出的密文（拒绝明文透传）")
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    try:
        blob = base64.urlsafe_b64decode(token[len(PREFIX):].encode("ascii"))
        if len(blob) <= _NONCE_LEN:
            raise ValueError("ciphertext too short")
        nonce, ct = blob[:_NONCE_LEN], blob[_NONCE_LEN:]
        pt = AESGCM(_master_key()).decrypt(nonce, ct, _aad(section, name))
    except ConfigSecretError:
        raise
    except Exception as exc:  # noqa: BLE001 — 只回异常类型，不回密文细节
        raise ConfigSecretError(
            f"密文解密失败（篡改/AAD 不匹配/主密钥不一致: {type(exc).__name__}）"
        ) from exc
    return pt.decode("utf-8")


def is_encrypted(value: object) -> bool:
    """``value`` 是否为本模块格式的密文"""
    return isinstance(value, str) and value.startswith(PREFIX)


def reset_master_cache() -> None:
    """清空主密钥派生缓存（测试中切换环境变量后调用）"""
    global _master
    with _lock:
        _master = None
