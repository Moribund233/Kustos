"""协作内容域：Issue、Pull Request（及其评审/标签/关联/活动子域）、标签、行内评论、Release、协作邀请与统计看板。

包内 ``__init__`` 保持轻量：不 re-export 具体模块，
避免子包之间的循环导入（导入请写全路径
``from app.services.collaboration.<module> import ...``）。
"""
