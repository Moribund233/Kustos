"""消息域：站内通知、通知偏好与聊天附件。

包内 ``__init__`` 保持轻量：不 re-export 具体模块，
避免子包之间的循环导入（导入请写全路径
``from app.services.messaging.<module> import ...``）。
"""
