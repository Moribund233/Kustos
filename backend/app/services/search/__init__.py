"""搜索域：代码检索主服务与搜索/embedding 管理面。

包内 ``__init__`` 保持轻量：不 re-export 具体模块，
避免子包之间的循环导入（导入请写全路径
``from app.services.search.<module> import ...``）。
"""
