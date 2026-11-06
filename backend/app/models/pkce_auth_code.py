"""PKCE 授权码存储

桌面端登录不该要求用户在应用里输密码：企业环境的 SSO/2FA 账号根本走不通。
PKCE 授权码流把登录交给系统浏览器（用户已经在那里登录过），桌面端只拿回一个
授权码，再凭自己生成的 ``code_verifier`` 换令牌——全程不接触密码。

这里的表只承担一件事：**在授权码的极短生命周期内记住它的绑定关系**。

三条安全绑定缺一不可：

- ``code_challenge``：只存 SHA256(verifier)，服务端从不持有 verifier 本身。
  截获授权码但没有 verifier 也换不出令牌。
- ``redirect_uri`` / ``client_id``：换令牌时必须与授权时一致，防止授权码
  被引导到别的地址。
- ``expires_at`` + ``used_at``：短命且一次性。重放必须失败，否则一次截获
  就能无限换令牌。

授权码本身用高熵随机串（32 字节），不做可逆编码——它不是标识符，只是凭证。
"""

from sqlalchemy import DateTime, ForeignKey, Index, String
from sqlalchemy.orm import mapped_column

from app.models.base import TimestampMixin


class PkceAuthorizationCode(TimestampMixin):
    """一次 PKCE 授权的临时凭证。"""

    __tablename__ = "pkce_authorization_codes"
    __table_args__ = (
        Index("ix_pkce_codes_code", "code", unique=True),
        Index("ix_pkce_codes_expires_at", "expires_at"),
    )

    code = mapped_column(String(128), nullable=False)
    """授权码明文（高熵随机串，一次性）"""

    client_id = mapped_column(String(64), nullable=False)
    """发起授权的客户端；换令牌时必须一致"""

    redirect_uri = mapped_column(String(500), nullable=False)
    """回调地址；换令牌时必须一致，防止伪造重定向窃取"""

    code_challenge = mapped_column(String(128), nullable=False)
    """SHA256(code_verifier) 的 base64url；服务端从不存储 verifier 本身"""

    code_challenge_method = mapped_column(String(16), nullable=False, default="S256")
    """固定 S256；plain 会明文传递 verifier，等于没有 PKCE"""

    user_id = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    """授权给哪个用户（浏览器里已登录的那个）"""

    expires_at = mapped_column(DateTime(timezone=True), nullable=False)
    """过期时刻；超过即拒绝，默认 5 分钟"""

    used_at = mapped_column(DateTime(timezone=True), nullable=True)
    """首次兑换的时刻；非空表示已用过，重放必须拒绝"""

    def is_usable(self) -> bool:
        """未使用即视为可用（时间判定由服务层做，便于测试注入时钟）。"""
        return self.used_at is None
