# Prüfstand „native Box“ für die Release-Paket-Tests (docs/release-pakete.md):
# Debian bookworm mit systemd als PID 1, Pakete, die install.sh ohnehin holt,
# und Node 22 (NodeSource) vorinstalliert — install.sh überspringt dann nur
# den Download. Kein DVhub-Code im Image; den holt install.sh aus dem Spiegel.
#
#   docker build -t dvhub-boxsim:bookworm-2 scripts/release/boxsim
#
# systemd-binfmt ist maskiert: der Container läuft privilegiert, und
# systemd-binfmt leert beim Start die binfmt-Tabelle des ganzen Docker-Hosts
# (Colima-VM) — danach liefen amd64-Images nicht mehr (beobachtet 27.10.2026).
#   docker run -d --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
#     --tmpfs /run --tmpfs /run/lock --sysctl net.ipv4.ip_unprivileged_port_start=0 dvhub-boxsim:bookworm-2
FROM debian:bookworm
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus ca-certificates curl gnupg git sudo \
      postgresql openvpn strongswan python3-venv python3-pip autossh openssh-client libjemalloc2 \
      procps iproute2 openssl less tar gzip \
 && apt-get install -y --no-install-recommends wireguard-tools \
 && if [ "$(dpkg --print-architecture)" = armhf ]; then \
      # NodeSource baut für armhf nicht mehr (nur amd64/arm64): offizielles
      # Node-22-Archiv von nodejs.org, Prüfsumme fest eingetragen.
      apt-get install -y --no-install-recommends xz-utils libatomic1 \
      && curl -fsSLo /tmp/node.tar.xz https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-armv7l.tar.xz \
      && echo "c9057c6a3b8fbb9651ed115c1e96d4a7281b7b9c9ca89fa05865c98ed7ffd437  /tmp/node.tar.xz" | sha256sum -c - \
      && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && rm /tmp/node.tar.xz \
      && ln -sf /usr/local/bin/node /usr/bin/node && ln -sf /usr/local/bin/npm /usr/bin/npm && ln -sf /usr/local/bin/npx /usr/bin/npx; \
    else \
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs; \
    fi \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl mask getty@.service serial-getty@.service systemd-logind.service console-getty.service \
      systemd-timesyncd.service apt-daily.timer apt-daily-upgrade.timer e2scrub_reap.service \
      systemd-binfmt.service proc-sys-fs-binfmt_misc.automount proc-sys-fs-binfmt_misc.mount
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
