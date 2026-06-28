#!/bin/bash
# Apply the DVhub-fork patches to a local EOS install.
#
# DVhub-fork features added on top of vanilla akkudoktor/EOS v0.3.0:
#   1. 15-min optimization slots (genetic algo interval=900) — vanilla EOS hard-
#      clamps this to 3600.
#   2. Slot-aware battery + inverter Math (Phase 22) — power-caps × slot_duration_h.
#      Without this, the genetic algo would charge the battery 4× faster than
#      physics at interval=900.
#   3. loadforecast_power_w * power_to_energy_per_interval_factor (Phase 22) —
#      vanilla EOS forgot to scale the load series; PV had the factor, load
#      didn't. At interval=900 this skewed cost ~4× too high.
#   4. FeedInTariffEnergyCharts provider — spot-dynamic feed-in for DV-
#      Vermarktung operators. Vanilla EOS only ships Fixed + Import.
#   5. FeedInTariffEnergyCharts charges-unwind (Phase 22) — when
#      elecprice.charges_kwh > 0 the elec series is the Endkundenpreis; the
#      mirror unwinds VAT+charges so feed-in stays pure spot.
#   6. Pydantic-json.dumps serialization bug fix in /v1/prediction/import/{id}
#      handler (vanilla returns HTTP 400 when body is PydanticDateTimeData).
#
# Idempotent: safe to re-run after every EOS upgrade. Detects already-applied
# patches via marker grep and skips them. For the larger refactor patches
# (battery/inverter/genetic/geneticparams) we ship full drop-in files —
# detection is via the "DVhub fork:" marker comment in each file.
#
# Usage:
#   sudo bash eos-patches/apply.sh /opt/dvhub/eos
#
# After apply: systemctl restart eos
set -euo pipefail

EOS_ROOT="${1:-/opt/dvhub/eos}"
PATCH_DIR="$(cd "$(dirname "$0")" && pwd)"

# Drop-in helper for slot-aware refactor files. Idempotent via marker grep.
# Backs the original up as *.dvhub-fork.bak on first apply so a revert is
# trivially `mv *.bak <original>`.
apply_dropin() {
    local target="$1"      # full path under $EOS_ROOT
    local source="$2"      # filename under $PATCH_DIR/drop-in/
    local marker="$3"      # text snippet that proves the drop-in is in place
    if [ ! -f "$target" ]; then
        echo "  → ERROR: target $target does not exist"
        exit 1
    fi
    if grep -q "$marker" "$target"; then
        echo "  → already applied, skipping"
        return
    fi
    cp "$target" "$target.dvhub-fork.bak"
    cp "$PATCH_DIR/drop-in/$source" "$target"
    echo "  → drop-in applied (backup: $target.dvhub-fork.bak)"
}

if [ ! -d "$EOS_ROOT/src/akkudoktoreos" ]; then
    echo "ERROR: EOS source not found at $EOS_ROOT/src/akkudoktoreos"
    echo "Pass the EOS install root as first arg: bash apply.sh /opt/dvhub/eos"
    exit 1
fi

echo "[1/9] Drop-in: geneticparams.py — ALLOWED_INTERVALS + loadforecast slot-scaling"
apply_dropin \
    "$EOS_ROOT/src/akkudoktoreos/optimization/genetic/geneticparams.py" \
    "geneticparams.py" \
    "DVhub fork: load is a power series"

echo "[2/9] Drop-in: genetic.py — total_slots property + 19 prediction.hours rewrites"
apply_dropin \
    "$EOS_ROOT/src/akkudoktoreos/optimization/genetic/genetic.py" \
    "genetic.py" \
    "def total_slots(self)"

echo "[3/9] Drop-in: battery.py — slot_duration_h-aware charge/discharge power caps"
apply_dropin \
    "$EOS_ROOT/src/akkudoktoreos/devices/genetic/battery.py" \
    "battery.py" \
    "slot_duration_h: float = 1.0"

echo "[4/9] Drop-in: inverter.py — slot_duration_h scales max_power_wh per slot"
apply_dropin \
    "$EOS_ROOT/src/akkudoktoreos/devices/genetic/inverter.py" \
    "inverter.py" \
    "slot_duration_h: float = 1.0"

echo "[5/9] Drop-in: homeappliance.py — slot_duration_h hook (forward-compat only)"
apply_dropin \
    "$EOS_ROOT/src/akkudoktoreos/devices/genetic/homeappliance.py" \
    "homeappliance.py" \
    "slot_duration_h: float = 1.0"

echo "[5b/9] Drop-in: retentionmanager.py — wall-clock slot-aligned EMS scheduling"
apply_dropin \
    "$EOS_ROOT/src/akkudoktoreos/server/retentionmanager.py" \
    "retentionmanager.py" \
    "last_run_slot: int = -1"

echo "[6/9] Install new provider: feedintariffenergycharts.py"
TARGET="$EOS_ROOT/src/akkudoktoreos/prediction/feedintariffenergycharts.py"
cp "$PATCH_DIR/feedintariffenergycharts.py" "$TARGET"
echo "  → installed at $TARGET (always overwritten — Phase 22 ships the charges-unwind)"

echo "[7/9] Register provider in feedintariff.py"
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

echo "[8/9] Register provider in prediction.py"
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

echo "[9/9] Apply json.dumps Pydantic fix in server/eos.py"
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
echo "All 9 patches applied. Next: systemctl restart eos"
echo "DVhub will push the runtime config (interval, charges_kwh, charge_rates"
echo "based on operator.allowGridCharge + mispel.mode) at the next"
echo "saveAndApplyConfig() or boot."
echo "Manual config (only if not running DVhub):"
echo "  PUT /v1/config/optimization/interval = 900"
echo "  PUT /v1/config/optimization/genetic/generations = 1200"
echo "  PUT /v1/config/feedintariff/provider = \"FeedInTariffEnergyCharts\""
echo "  PUT /v1/config/feedintariff/provider_settings/FeedInTariffEnergyCharts = {\"spot_factor\": 1.0}"
echo "  PUT /v1/config/elecprice/charges_kwh = 0.20    # if dynamic pricing on"
echo "  PUT /v1/config/elecprice/vat_rate = 1.19"
echo "  PUT /v1/config/ems/mode = \"OPTIMIZATION\""
echo "  PUT /v1/config/file        # persist to disk"
echo "================================================================"
