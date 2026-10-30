"""平台运维域：应用控制、配置管理、数据库重置、指标与监控栈、容器编排、保留策略、worker 注册表。

包内 ``__init__`` 保持轻量：不 re-export 具体模块，
避免子包之间的循环导入（导入请写全路径
``from app.services.platform.<module> import ...``）。
"""
