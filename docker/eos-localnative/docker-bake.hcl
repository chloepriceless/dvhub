// docker/eos-localnative/docker-bake.hcl — DVhub-EOS im local-native-Modus:
// das eigenständige Binär `dvhub-optimize serve` als EOS v0.4.0rc3-Fassade
// (optimizer.eosProxy.mode=local-native, 1.0.11, PLAN rust-1.1 §6.2 E2).
//
// Aufruf aus dem Repo-Wurzelordner (Pfade relativ dazu):
//   BINS_DIR=$(mktemp -d)
//   scripts/eos-native-wheels.sh fetch "$BINS_DIR" AARCH64 X86_64 --prefix EOS_NATIVE_BIN
//   export $(grep -E '^EOS_NATIVE_BIN_[A-Z0-9_]+=' eos-version.env)
//   BINS_DIR=$BINS_DIR TAGS=… \
//     docker buildx bake --allow=fs.read="$BINS_DIR" \
//       -f docker/eos-localnative/docker-bake.hcl [--push|--load] dvhub-eos-localnative
//
// --allow=fs.read=$BINS_DIR ist nötig, weil der bins-Kontext außerhalb des
// Build-Kontexts (docker/eos-localnative) liegt; --load lädt genau eine Arch,
// --push veröffentlicht die Multi-Arch-Liste.
//
// Analog docker/eos-native, nur mit dem Binär statt dem Wheel: eos-native-wheels.sh
// holt+prüft die Binäre (--prefix EOS_NATIVE_BIN), das Dockerfile prüft die sha256
// noch einmal. Die Binäre werden nach `uname -m` ausgewählt (NICHT pip-Tags:
// standalone, kein venv).

variable "BINS_DIR" { default = "" }
variable "EOS_NATIVE_BIN_VERSION" { default = "" }
variable "EOS_NATIVE_BIN_X86_64" { default = "" }
variable "EOS_NATIVE_BIN_X86_64_SHA256" { default = "" }
variable "EOS_NATIVE_BIN_AARCH64" { default = "" }
variable "EOS_NATIVE_BIN_AARCH64_SHA256" { default = "" }
variable "PLATFORMS" { default = "linux/amd64,linux/arm64" }
// Komma-getrennt; leer = ohne Namen (nur bauen und prüfen).
variable "TAGS" { default = "" }

target "dvhub-eos-localnative" {
  context    = "docker/eos-localnative"
  dockerfile = "Dockerfile"
  contexts = {
    bins = BINS_DIR
  }
  args = {
    EOS_NATIVE_BIN_VERSION       = EOS_NATIVE_BIN_VERSION
    EOS_NATIVE_BIN_X86_64        = EOS_NATIVE_BIN_X86_64
    EOS_NATIVE_BIN_X86_64_SHA256 = EOS_NATIVE_BIN_X86_64_SHA256
    EOS_NATIVE_BIN_AARCH64       = EOS_NATIVE_BIN_AARCH64
    EOS_NATIVE_BIN_AARCH64_SHA256 = EOS_NATIVE_BIN_AARCH64_SHA256
  }
  platforms = split(",", PLATFORMS)
  tags      = compact(split(",", TAGS))
  labels = {
    "org.opencontainers.image.title"       = "DVhub-EOS (local-native)"
    "org.opencontainers.image.description" = "Eigenständiger Rust-Optimierer dvhub-optimize serve als EOS v0.4.0rc3-Fassade (eos-genetic), ohne Python-EOS"
    "org.opencontainers.image.version"     = EOS_NATIVE_BIN_VERSION
    "org.opencontainers.image.source"      = "https://github.com/chloepriceless/EOS"
    "org.opencontainers.image.licenses"    = "Apache-2.0"
    "net.dvhub.eos.engine"                 = "dvhub-optimize"
    "net.dvhub.eos.native-bin"             = EOS_NATIVE_BIN_VERSION
  }
}
