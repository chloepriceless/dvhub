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
#     --tmpfs /run --tmpfs /run/lock --sysctl net.ipv4.ip_unprivileged_port_start=0 dvhub-boxsim:bookworm-1
FROM debian:bookworm
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus ca-certificates curl gnupg git sudo \
      postgresql openvpn strongswan python3-venv python3-pip autossh openssh-client libjemalloc2 \
      procps iproute2 openssl less tar gzip \
 && apt-get install -y --no-install-recommends wireguard-tools \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl mask getty@.service serial-getty@.service systemd-logind.service console-getty.service \
      systemd-timesyncd.service apt-daily.timer apt-daily-upgrade.timer e2scrub_reap.service \
      systemd-binfmt.service proc-sys-fs-binfmt_misc.automount proc-sys-fs-binfmt_misc.mount
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
