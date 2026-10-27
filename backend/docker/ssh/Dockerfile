FROM alpine:3.20

# curl: pre/post-receive hook 回调应用
RUN apk add --no-cache openssh git py3-pip py3-psycopg2 curl

# 用 UID 1000 创建 git 用户（对齐 app 容器的 kustos 用户）
# 仓库目录属主对齐 uid=1000，避免共享卷 repos 首次初始化时属主为 root 导致不可写
RUN mkdir -p /data/repositories && \
    chown -R 1000:1000 /data/repositories && \
    adduser -D -u 1000 -h /home/git -s /usr/local/bin/git-shell-wrapper git && \
    passwd -u git && \
    ssh-keygen -A

# 构建上下文为 ./docker：路径均相对上下文
# SSH 公钥查询脚本
COPY ssh/authorized_keys_query.py /usr/local/bin/authorized_keys_query
RUN chmod +x /usr/local/bin/authorized_keys_query

# Git Shell 包装器
COPY ssh/git-shell-wrapper /usr/local/bin/git-shell-wrapper
RUN chmod +x /usr/local/bin/git-shell-wrapper

# Git hook（pre/post-receive）：与 git-cgi 镜像同一套集中 hooks
# （构建上下文为 ./docker；hook.conf 由 CMD 在启动时生成）
COPY git-hooks/ /opt/kustos/hooks/
RUN chmod +x /opt/kustos/hooks/pre-receive /opt/kustos/hooks/post-receive && \
    git config --system core.hooksPath /opt/kustos/hooks

# sshd_config
RUN sed -i \
    -e 's/^#AuthorizedKeysCommand none/AuthorizedKeysCommand \/usr\/local\/bin\/authorized_keys_query/' \
    -e 's/^#AuthorizedKeysCommandUser nobody/AuthorizedKeysCommandUser git/' \
    -e 's/^#Port 22/Port 2222/' \
    -e 's/^#PermitRootLogin.*/PermitRootLogin no/' \
    -e 's/^#PasswordAuthentication.*/PasswordAuthentication no/' \
    -e 's/^#PubkeyAuthentication.*/PubkeyAuthentication yes/' \
    /etc/ssh/sshd_config

EXPOSE 2222
# 启动时生成 hook 运行时配置（应用回调端点 + 共享密钥），再拉起 sshd
# umask 077 限 0600 落盘；chown git：pre/post-receive hook 以 git 用户执行
# （sshd 登录身份），0600 root-only 会让 hook fail-closed 拒绝全部推送
CMD ["sh", "-c", "(umask 077; { echo \"KUSTOS_GIT_HOOK_URL=\\\"${KUSTOS_APP_URL:-http://app:8000}/api/v1/git-internal\\\"\"; echo \"KUSTOS_GIT_HOOK_SECRET=\\\"${KUSTOS_GIT_HOOK_SECRET:-}\\\"\"; echo \"KUSTOS_GIT_HOOK_ROOT=\\\"/data/repositories\\\"\"; } > /opt/kustos/hooks/hook.conf && chown git:git /opt/kustos/hooks/hook.conf) && exec /usr/sbin/sshd -D -e"]
