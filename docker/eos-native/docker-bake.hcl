// docker/eos-native/docker-bake.hcl — DVhub-EOS mit Rust-Kern (T-0415).
//
// Aufruf aus dem Repo-Wurzelordner (Pfade relativ dazu):
//   scripts/eos-native-wheels.sh fetch "$WHEELS_DIR" X86_64 AARCH64
//   export $(grep -E '^EOS_NATIVE_[A-Z0-9_]+=' eos-version.env)
//   EOS_REPO=… EOS_TAG=… EOS_IMAGE_TAG=… WHEELS_DIR=… TAGS=… \
//     docker buildx bake -f docker/eos-native/docker-bake.hcl [--push] dvhub-eos
// Die CI (.github/workflows/container*.yml) setzt EOS_REPO/EOS_TAG/EOS_IMAGE_TAG
// aus scripts/eos-image-plan.sh (docker/.env.example).
//
// eos-base: das unveränderte Root-Dockerfile des Forks am Git-Tag (wie
// tools/dvhub-eos/build-image.sh, Stufe 1) — nur Zwischenstufe, wird nie
// veröffentlicht. dvhub-eos: Wheel + Backend native + Rauchtest
// (docker/eos-native/Dockerfile).

variable "EOS_REPO" { default = "https://github.com/chloepriceless/EOS.git" }
variable "EOS_TAG" { default = "" }
variable "EOS_IMAGE_TAG" { default = "" }
variable "WHEELS_DIR" { default = "" }
variable "EOS_NATIVE_VERSION" { default = "" }
variable "EOS_NATIVE_X86_64" { default = "" }
variable "EOS_NATIVE_X86_64_SHA256" { default = "" }
variable "EOS_NATIVE_AARCH64" { default = "" }
variable "EOS_NATIVE_AARCH64_SHA256" { default = "" }
variable "PLATFORMS" { default = "linux/amd64,linux/arm64" }
// Komma-getrennt; leer = ohne Namen (nur bauen und prüfen).
variable "TAGS" { default = "" }

target "eos-base" {
  context   = "${EOS_REPO}#${EOS_TAG}"
  args      = { BUILD_VERSION = EOS_IMAGE_TAG }
  platforms = split(",", PLATFORMS)
}

target "dvhub-eos" {
  context    = "docker/eos-native"
  dockerfile = "Dockerfile"
  contexts = {
    base         = "target:eos-base"
    wheels       = WHEELS_DIR
    dvhubscripts = "scripts"
  }
  args = {
    EOS_NATIVE_X86_64         = EOS_NATIVE_X86_64
    EOS_NATIVE_X86_64_SHA256  = EOS_NATIVE_X86_64_SHA256
    EOS_NATIVE_AARCH64        = EOS_NATIVE_AARCH64
    EOS_NATIVE_AARCH64_SHA256 = EOS_NATIVE_AARCH64_SHA256
  }
  platforms = split(",", PLATFORMS)
  tags      = compact(split(",", TAGS))
  labels = {
    "org.opencontainers.image.title"       = "DVhub-EOS"
    "org.opencontainers.image.description" = "Akkudoktor-EOS main + offene PRs (Fork chloepriceless/EOS), GENETIC im Rust-Kern"
    "org.opencontainers.image.version"     = EOS_IMAGE_TAG
    "org.opencontainers.image.source"      = "https://github.com/chloepriceless/EOS"
    "org.opencontainers.image.licenses"    = "Apache-2.0"
    "net.dvhub.eos.git-tag"                = EOS_TAG
    "net.dvhub.eos.upstream"               = "https://github.com/Akkudoktor-EOS/EOS"
    "net.dvhub.eos.native"                 = EOS_NATIVE_VERSION
  }
}
