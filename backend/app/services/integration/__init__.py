"""外部集成域：Git hooks 回调、Webhook 投递与签名、CI 构建记录。

包内 ``__init__`` 保持轻量：不 re-export 具体模块，
避免子包之间的循环导入（导入请写全路径
``from app.services.integration.<module> import ...``）。
"""
