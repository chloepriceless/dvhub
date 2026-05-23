# DVhub EOS Fork Patches

Minimal local patches on top of [akkudoktor/EOS](https://github.com/Akkudoktor-EOS/EOS) v0.3.0 that add two operator-critical features missing upstream:

1. **15-min optimization slots** — vanilla EOS hard-clamps `optimization.interval` to 3600 seconds. The genetic algorithm's slot math is already interval-aware (`power_to_energy_per_interval_factor = interval / 3600`); the clamp is just defensive over untested territory. We allow `{900, 1800, 3600}`.

2. **`FeedInTariffEnergyCharts` provider** — vanilla EOS treats `elecprice` (what you pay) and `feedintariff` (what you receive) as fully independent inputs. The only feed-in providers are `Fixed` (one static value forever) or `Import` (self-managed file). Operators on German Spot-Vermarktung get `EPEX × spot_factor` as their feed-in revenue — fundamentally a copy of `elecprice` with a multiplier. This new provider reads the `elecprice_marketprice_wh` series the existing `ElecPriceEnergyCharts` already populated, multiplies by `spot_factor` (default 1.0), and writes it into `feed_in_tariff_wh`. No second HTTP fetch.

3. **Bonus**: also fixes a Pydantic serialization bug in `/v1/prediction/import/{provider_id}` (vanilla returns HTTP 400 when the body validates as a Pydantic model because `json.dumps(model)` then fails — fixed with `model_dump_json()`).

## Files in this directory

- `apply.sh` — idempotent installer, takes EOS install root as arg
- `feedintariffenergycharts.py` — the new provider (gets copied into `prediction/`)
- `README.md` — this file

## Apply / Re-apply

After every `git pull` in the EOS source tree (e.g. EOS upgrade):

```bash
sudo bash /home/dev/dvhub/eos-patches/apply.sh /opt/dvhub/eos
sudo systemctl restart eos
```

Each patched source file gets a `.dvhub-fork.bak` sibling for one-shot revert.

## EOS configuration after apply

```
PUT /v1/config/optimization/interval                                            -d 900
PUT /v1/config/optimization/genetic/generations                                 -d 1200
PUT /v1/config/feedintariff/provider                                            -d '"FeedInTariffEnergyCharts"'
PUT /v1/config/feedintariff/provider_settings/FeedInTariffEnergyCharts          -d '{"spot_factor": 1.0}'
PUT /v1/config/ems/mode                                                         -d '"OPTIMIZATION"'
PUT /v1/config/file                       # persist to /opt/dvhub/eos/EOS.config.json
```

`generations=1200` (vs. vanilla 400) is needed for genetic-algo convergence with 4× more decision variables at 15-min resolution. Pro Lauf ~90s statt ~30s — vertretbar bei `ems.interval: 300`.

`spot_factor=1.0` matches DVhub's `optimizer.tariff.feedInSpotFactor` for full Spot-Vermarktung. Set to `0.97` etc. for brokers who skim.

## Verifying the fork is live

```bash
# 1. Patches present in source
grep -c ALLOWED_INTERVALS /opt/dvhub/eos/src/akkudoktoreos/optimization/genetic/geneticparams.py
grep -c FeedInTariffEnergyChartsCommonSettings /opt/dvhub/eos/src/akkudoktoreos/prediction/feedintariff.py
test -f /opt/dvhub/eos/src/akkudoktoreos/prediction/feedintariffenergycharts.py && echo OK

# 2. Runtime config respects 15-min interval
curl -s http://localhost:8503/v1/config/optimization/interval
# expected: 900

# 3. Plan has ~96 instructions per device per day (4× the vanilla 24)
curl -s http://localhost:8503/v1/energy-management/plan | python3 -c "
import json,sys; p=json.load(sys.stdin)
n=len([i for i in p.get('instructions',[]) if i.get('actuator_id','').startswith('battery')])
print(f'battery instructions: {n} (expect ~96 for 24h horizon with 15-min slots)')
"

# 4. FeedInTariffEnergyCharts is delivering spot-mirrored values
curl -s "http://localhost:8503/v1/prediction/series?key=feed_in_tariff_wh" | python3 -c "
import json,sys; d=json.load(sys.stdin); items=list(d.get('data',{}).items())
print(f'feed-in slots stored: {len(items)}')
[print(' ',t,'→',round(v*1000,2),'ct/kWh') for t,v in items[:6]]
"
```

## Risks / known limits

- Genetic convergence at 15-min × 4 devices (battery + EV + homeapp + ...) is empirically slower; if plans look noisy, raise `generations` further (1600–2000) or accept the ~minute-scale optimization wall-clock.
- The `FeedInTariffEnergyCharts` provider **requires** `ElecPriceEnergyCharts` to be the active elecprice provider (or co-running). Switching elecprice to `ElecPriceAkkudoktor` or `Fixed` will leave feed-in empty.
- Upstream EOS may evolve the FastAPI body-parsing in ways that resurface the json.dumps bug — the patch's `hasattr(data, 'model_dump_json')` guard is forward-compatible but worth checking after major upgrades.

## Maintainer notes

The diff is intentionally small (4 files touched, ~60 lines net) to maximize merge-back upstream:
- `optimization/genetic/geneticparams.py` (~10 lines)
- `prediction/feedintariff.py` (~6 lines)
- `prediction/prediction.py` (~9 lines)
- `prediction/feedintariffenergycharts.py` (new, ~80 lines)
- `server/eos.py` (1 line)

Pre-patch backups saved alongside originals as `*.dvhub-fork.bak`.
