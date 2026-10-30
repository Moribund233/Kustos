"""Git LFS 域：业务逻辑、存储后端与短时效 transfer token。

包内 ``__init__`` 保持轻量：不 re-export 具体模块，
避免子包之间的循环导入（导入请写全路径
``from app.services.lfs.<module> import ...``）。
"""
