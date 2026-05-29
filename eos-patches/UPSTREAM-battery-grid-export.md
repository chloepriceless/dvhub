# For the Akkudoktor-EOS maintainer — missing feature

The genetic inverter model (`devices/genetic/inverter.py` → `Inverter.process_energy`) has **no battery→grid discharge path**: `grid_export` is only ever PV surplus (Case 1), and in Case 2 (load > PV) the battery may *only* discharge to cover the local shortfall — `grid_export` stays `0`. So the `discharge` gene / `GRID_SUPPORT_EXPORT` mode label can express "sell from battery to the grid," but the simulator can never realise it.

Consequence: a battery cannot be optimised to **arbitrage-discharge into the grid at the evening price peak** (Direktvermarktung / dynamic feed-in), so it can never be emptied faster than household load — it stays full overnight and curtails the next day's PV.

Fix is small and local: in `process_energy` Case 2, after covering load, if discharge is allowed for the slot, discharge additional battery energy into `grid_export` up to the inverter AC headroom (`max_power_wh − generation`) and battery power cap; revenue then falls out of the existing `feedin × feed_in_tariff` term and the negative-price curtailment guard already protects it. (DVhub ships exactly this as a fork patch — happy to open a PR.)
