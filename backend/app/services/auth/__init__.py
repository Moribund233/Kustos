"""认证与用户域：令牌生命周期、撤销位图、OAuth 适配器与用户账号。

包内 ``__init__`` 保持轻量：不 re-export 具体模块，
避免子包之间的循环导入（导入请写全路径
``from app.services.auth.<module> import ...``）。
"""
