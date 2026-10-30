"""仓库与 Git 对象域：仓库本体、浏览器、分支、提交、成员、密钥、fork/star/watch、语言统计与活动审计。

包内 ``__init__`` 保持轻量：不 re-export 具体模块，
避免子包之间的循环导入（导入请写全路径
``from app.services.repository.<module> import ...``）。
"""
