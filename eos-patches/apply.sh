#!/bin/bash
# Apply the DVhub-fork patches to a local EOS install.
#
# DVhub-fork features added on top of vanilla akkudoktor/EOS v0.3.0:
#   1. 15-min optimization slots (genetic algo interval=900) — vanilla EOS hard-
#      clamps this to 3600.
#   2. FeedInTariffEnergyCharts provider — spot-dynamic feed-in for DV-
#      Vermarktung operators. Vanilla EOS only ships Fixed + Import.
#   3. Pydantic-json.dumps serialization bug fix in /v1/prediction/import/{id}
#      handler (vanilla returns HTTP 400 when body is PydanticDateTimeData).
#
# Idempotent: safe to re-run after every EOS upgrade. Detects already-applied
# patches via marker grep and skips them.
#
# Usage:
#   sudo bash eos-patches/apply.sh /opt/dvhub/eos
#
# After apply: systemctl restart eos
set -euo pipefail

EOS_ROOT="${1:-/opt/dvhub/eos}"
PATCH_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$EOS_ROOT/src/akkudoktoreos" ]; then
    echo "ERROR: EOS source not found at $EOS_ROOT/src/akkudoktoreos"
    echo "Pass the EOS install root as first arg: bash apply.sh /opt/dvhub/eos"
    exit 1
fi

echo "[1/5] Apply patch: geneticparams.py — allow optimization.interval ∈ {900, 1800, 3600}"
GP="$EOS_ROOT/src/akkudoktoreos/optimization/genetic/geneticparams.py"
if grep -q "ALLOWED_INTERVALS" "$GP"; then
    echo "  → already applied, skipping"
else
    cp "$GP" "$GP.dvhub-fork.bak"
    python3 - "$GP" <<'PY'
import sys, re
path = sys.argv[1]
src = open(path, encoding='utf-8').read()
# Match the original 8-line clamp block exactly.
old = '''        if cls.config.optimization.interval is None:
            logger.info("Optimization interval unknown - defaulting to 3600 seconds.")
            cls.config.optimization.interval = 3600
        if cls.config.optimization.interval != 3600:
            logger.info(
                "Optimization interval '{}' seconds not supported - forced to 3600 seconds."
            )
            cls.config.optimization.interval = 3600'''
new = '''        if cls.config.optimization.interval is None:
            cls.config.optimization.interval = 3600
        # DVhub fork: allow 15-min slots. Slot-math at line ~230 is already
        # interval-aware (power_to_energy_per_interval_factor = interval/3600).
        ALLOWED_INTERVALS = (3600, 1800, 900)
        if cls.config.optimization.interval not in ALLOWED_INTERVALS:
            logger.warning(
                f"Optimization interval {cls.config.optimization.interval}s "
                f"not in {ALLOWED_INTERVALS} - forcing 3600."
            )
            cls.config.optimization.interval = 3600'''
if old not in src:
    raise SystemExit("ERROR: vanilla clamp block not found — EOS upstream may have changed")
src = src.replace(old, new)
open(path, 'w', encoding='utf-8').write(src)
PY
    echo "  → patched"
fi

echo "[2/5] Install new provider: feedintariffenergycharts.py"
TARGET="$EOS_ROOT/src/akkudoktoreos/prediction/feedintariffenergycharts.py"
cp "$PATCH_DIR/feedintariffenergycharts.py" "$TARGET"
echo "  → installed at $TARGET"

echo "[3/5] Register provider in feedintariff.py"
FT="$EOS_ROOT/src/akkudoktoreos/prediction/feedintariff.py"
if grep -q "FeedInTariffEnergyChartsCommonSettings" "$FT"; then
    echo "  → already applied, skipping"
else
    cp "$FT" "$FT.dvhub-fork.bak"
    python3 - "$FT" <<'PY'
import sys
path = sys.argv[1]
src = open(path, encoding='utf-8').read()
# Insert the import alongside the other settings imports.
import_old = "from akkudoktoreos.prediction.feedintariffimport import FeedInTariffImportCommonSettings"
import_new = (
    "from akkudoktoreos.prediction.feedintariffimport import FeedInTariffImportCommonSettings\n"
    "from akkudoktoreos.prediction.feedintariffenergycharts import FeedInTariffEnergyChartsCommonSettings"
)
if import_old not in src:
    raise SystemExit("ERROR: import anchor not found in feedintariff.py")
src = src.replace(import_old, import_new)
# Insert the provider_settings field after the FeedInTariffImport one.
field_old = '''    FeedInTariffImport: Optional[FeedInTariffImportCommonSettings] = Field(
        default=None,
        json_schema_extra={"description": "FeedInTariffImport settings", "examples": [None]},
    )'''
field_new = field_old + (
    "\n    FeedInTariffEnergyCharts: Optional[FeedInTariffEnergyChartsCommonSettings] = Field(\n"
    "        default=None,\n"
    "        json_schema_extra={\"description\": \"FeedInTariffEnergyCharts settings (DVhub fork)\", \"examples\": [None]},\n"
    "    )"
)
if field_old not in src:
    raise SystemExit("ERROR: provider_settings anchor not found in feedintariff.py")
src = src.replace(field_old, field_new)
open(path, 'w', encoding='utf-8').write(src)
PY
    echo "  → patched"
fi

echo "[4/5] Register provider in prediction.py"
PRED="$EOS_ROOT/src/akkudoktoreos/prediction/prediction.py"
if grep -q "feedintariff_energycharts" "$PRED"; then
    echo "  → already applied, skipping"
else
    cp "$PRED" "$PRED.dvhub-fork.bak"
    python3 - "$PRED" <<'PY'
import sys
path = sys.argv[1]
src = open(path, encoding='utf-8').read()

# 1. Add import.
old = "from akkudoktoreos.prediction.feedintariffimport import FeedInTariffImport"
new = old + "\nfrom akkudoktoreos.prediction.feedintariffenergycharts import FeedInTariffEnergyCharts"
if old not in src: raise SystemExit("import anchor missing")
src = src.replace(old, new)

# 2. Add singleton instantiation.
old = "feedintariff_import = FeedInTariffImport()"
new = old + "\nfeedintariff_energycharts = FeedInTariffEnergyCharts()"
if old not in src: raise SystemExit("singleton anchor missing")
src = src.replace(old, new)

# 3. Add to BOTH Union[...] type lists (factory return + Prediction class field).
old = "        FeedInTariffImport,\n        LoadAkkudoktor,"
new = "        FeedInTariffImport,\n        FeedInTariffEnergyCharts,\n        LoadAkkudoktor,"
# This pattern appears twice — replace both.
count = src.count(old)
if count == 0: raise SystemExit("Union anchor missing")
src = src.replace(old, new)

# 4. Add to the `global` declaration in prediction_providers().
old = "        feedintariff_import, \\"
new = "        feedintariff_import, \\\n        feedintariff_energycharts, \\"
if old not in src: raise SystemExit("global anchor missing")
src = src.replace(old, new)

# 5. Add to the return list (after feedintariff_import). FeedIn-EC depends on
# elec data, so it must run AFTER elec providers but is fine right after
# feedintariff_import.
old = "        feedintariff_import,\n        loadforecast_akkudoktor,"
new = "        feedintariff_import,\n        feedintariff_energycharts,\n        loadforecast_akkudoktor,"
if old not in src: raise SystemExit("return-list anchor missing")
src = src.replace(old, new)

open(path, 'w', encoding='utf-8').write(src)
PY
    echo "  → patched"
fi

echo "[5/5] Apply json.dumps Pydantic fix in server/eos.py"
EOSPY="$EOS_ROOT/src/akkudoktoreos/server/eos.py"
if grep -q "model_dump_json() if hasattr(data" "$EOSPY"; then
    echo "  → already applied, skipping"
else
    cp "$EOSPY" "$EOSPY.dvhub-fork.bak" 2>/dev/null || true
    sed -i 's|provider.import_from_json(json_str=json.dumps(data))|provider.import_from_json(json_str=data.model_dump_json() if hasattr(data, "model_dump_json") else json.dumps(data))|' "$EOSPY"
    if grep -q "model_dump_json() if hasattr(data" "$EOSPY"; then
        echo "  → patched"
    else
        echo "  → ERROR: sed didn't match (vanilla line may have changed). Manual review needed."
        exit 1
    fi
fi

echo
echo "================================================================"
echo "All 5 patches applied. Next: systemctl restart eos"
echo "Then configure via REST:"
echo "  PUT /v1/config/optimization/interval = 900"
echo "  PUT /v1/config/optimization/genetic/generations = 1200"
echo "  PUT /v1/config/feedintariff/provider = \"FeedInTariffEnergyCharts\""
echo "  PUT /v1/config/feedintariff/provider_settings/FeedInTariffEnergyCharts = {\"spot_factor\": 1.0}"
echo "  PUT /v1/config/ems/mode = \"OPTIMIZATION\""
echo "  PUT /v1/config/file        # persist to disk"
echo "================================================================"
