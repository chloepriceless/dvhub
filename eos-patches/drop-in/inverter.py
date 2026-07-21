import os
from typing import Optional

from loguru import logger

from akkudoktoreos.devices.genetic.battery import Battery
from akkudoktoreos.optimization.genetic.geneticdevices import InverterParameters
from akkudoktoreos.prediction.interpolator import get_eos_load_interpolator

# DVhub fork (2026-05-29): battery→grid arbitrage discharge (Option B).
# Vanilla EOS' inverter has NO battery→grid path — in Case 2 the battery may
# only discharge to cover local load; grid_export is always PV-only. That
# prevents the optimizer from selling stored energy at the evening price peak
# and emptying the battery overnight to make room for next-day PV. We add that
# path below. Gated by an env var so the feature can be reverted without a code
# change: set EOS_BATTERY_GRID_EXPORT=0 (then restart eos) to fall back to the
# vanilla self-consumption-only behaviour (= "Option A": DVhub's Börsenautomatik
# handles evening sales instead). Default ON — this is the operator's #1 goal.
# NOTE: grid DISCHARGE/sale (Direktvermarktung) is the legal case and is
# intentionally NOT tied to the grid-CHARGE gate (max_ac_charge_power_w / §14a).
_BATTERY_GRID_EXPORT_ENABLED = os.environ.get("EOS_BATTERY_GRID_EXPORT", "1") not in (
    "0",
    "false",
    "False",
    "no",
)

# DVhub fork (2026-05-30): self-consumption priority. For a fixed-tariff operator
# the grid import price is always higher than any spot feed-in, so covering the
# house load from a charged battery beats both importing AND selling — at ANY
# price level. With this on, Case 2 covers the load from the battery regardless
# of the genetic's discharge gene (the gene then governs only grid export). This
# is the robust, price-independent cure for "buys the night back from the grid
# while the battery is charged" — replacing the brittle high-residual-value hack.
# Disable (EOS_SELF_CONSUMPTION_PRIORITY=0, restart eos) for dynamic-tariff
# operators where holding the battery through a cheap-import window can pay.
_SELF_CONSUMPTION_PRIORITY = os.environ.get("EOS_SELF_CONSUMPTION_PRIORITY", "1") not in (
    "0",
    "false",
    "False",
    "no",
)


# DVhub fork (2026-07-20, Christin): load-dependent inverter efficiency curve.
# The stock model uses ONE constant dc_to_ac_efficiency for every conversion —
# a 200 W trickle discharge is modelled as efficient as a 4 kW block, although
# a real MultiPlus is markedly worse at low partial load (fixed losses). The
# curve is given NORMALISED over slot-AC utilisation (P/Pnenn via
# ac_wh / max_power_wh), so the SAME curve scales across device sizes: a
# MultiPlus 10000 behaves ≈ 2× MultiPlus 5000 in parallel, and paralleling
# preserves η(P/Pnenn) exactly (each unit runs at the same relative load).
#
# Format: EOS_INVERTER_EFF_CURVE="frac:eta,frac:eta,..."  e.g. MultiPlus-II-ish
#   "0.02:0.75,0.05:0.86,0.10:0.92,0.20:0.945,0.35:0.95,0.60:0.945,1.0:0.93"
# Unset/empty/invalid → OFF (byte-identical legacy behaviour, constant eff).
# When ON, the curve REPLACES parameters.dc_to_ac_efficiency for the actual
# DC→AC conversions in process_energy(); it does NOT multiply on top (DVhub
# ships dc_to_ac_efficiency=1.0 — round-trip losses live in the battery
# efficiencies today, see dvhub eos-config-sync.js buildEosInverters. If the
# curve goes live for real, lower optimizer.roundTripEfficiency to the
# battery-only value or losses are double-counted).
# Scope v1 (documented, deliberate):
#   - Only DC→AC conversions are load-dependent. AC→DC (grid charge) keeps the
#     constant — the path is hard-disabled for §14a operators anyway.
#   - Capacity PRE-estimates (ac_unreserved, reserve→SoC translations) keep the
#     constant reference efficiency: they are planning bounds, not energy flows,
#     and must stay monotonic for the GA. Only real flows use the curve.
#   - genetic.py's seed/fast-path heuristics read the constant attribute
#     directly and are untouched (heuristics, not the billed simulation).
def _parse_eff_curve(raw: str):
    """'frac:eta,...' → sorted [(frac, eta), ...] with ≥2 points, else None."""
    if not raw:
        return None
    points = []
    try:
        for token in raw.split(","):
            token = token.strip()
            if not token:
                continue
            frac_s, eta_s = token.split(":")
            frac, eta = float(frac_s), float(eta_s)
            if not (0.0 <= frac <= 1.0) or not (0.0 < eta <= 1.0):
                logger.warning(f"EOS_INVERTER_EFF_CURVE: point out of range, curve OFF: {token}")
                return None
            points.append((frac, eta))
    except ValueError:
        logger.warning(f"EOS_INVERTER_EFF_CURVE: unparsable, curve OFF: {raw!r}")
        return None
    points.sort()
    if len(points) < 2:
        logger.warning("EOS_INVERTER_EFF_CURVE: needs >=2 points, curve OFF")
        return None
    return points


_EFF_CURVE = _parse_eff_curve(os.environ.get("EOS_INVERTER_EFF_CURVE", ""))

# v2 (Christin 2026-07-21): "überall mit dem Kurven-η rechnen". The reserve→SoC
# translations and the ac_unreserved capacity estimates have NO single
# conversion size to evaluate η at (they aggregate MANY future night slots), so
# they use η at a defined NIGHT OPERATING POINT: NIGHT_FRAC × Pnenn (default
# 6 % ≈ 1.4 kW on a 24 kW unit — typical overnight house load). v1 kept the
# constant there, which under-sized the reserve when the curve was on (replay
# 16.07.: night import 0.04 → 0.88 kWh). With η_night < 1 the same AC reserve
# maps to MORE SoC-Wh held back — the night is covered again.
_EFF_CURVE_NIGHT_FRAC = 0.06
try:
    _EFF_CURVE_NIGHT_FRAC = float(os.environ.get("EOS_INVERTER_EFF_CURVE_NIGHT_FRAC", "0.06"))
except ValueError:
    logger.warning("EOS_INVERTER_EFF_CURVE_NIGHT_FRAC unparsable, using 0.06")


class Inverter:
    def __init__(
        self,
        parameters: InverterParameters,
        battery: Optional[Battery] = None,
        slot_duration_h: float = 1.0,
    ):
        # DVhub fork: slot_duration_h scales the per-slot energy caps
        # (max_power_wh, max_ac_charge_power_w). Defaults to 1.0 which keeps
        # legacy hourly behaviour byte-identical.
        self.parameters: InverterParameters = parameters
        self.battery: Optional[Battery] = battery
        self.slot_duration_h: float = slot_duration_h
        self._setup()

    def _setup(self) -> None:
        if self.battery and self.parameters.battery_id != self.battery.parameters.device_id:
            error_msg = f"Battery ID mismatch - {self.parameters.battery_id} is configured; got {self.battery.parameters.device_id}."
            logger.error(error_msg)
            raise ValueError(error_msg)
        self.self_consumption_predictor = get_eos_load_interpolator()
        # DVhub fork: scale Wh-caps to actual slot length. Parameters are
        # supplied as power [W] values that the legacy code treats as Wh-per-
        # hour; at 15-min slots a slot can hold 1/4 of that.
        self.max_power_wh = (
            self.parameters.max_power_wh * self.slot_duration_h
        )  # Maximum energy the inverter can move in one optimization slot
        self.dc_to_ac_efficiency = self.parameters.dc_to_ac_efficiency
        self.ac_to_dc_efficiency = self.parameters.ac_to_dc_efficiency
        # Note: max_ac_charge_power_w stays as Watts. It feeds a power-ratio
        # cap computation in genetic.py:simulate() (max_dc_factor = …); the
        # ratio is dimensionless and slot-agnostic.
        self.max_ac_charge_power_w = self.parameters.max_ac_charge_power_w

    def _dc_ac_eff(self, ac_wh: float) -> float:
        """DC→AC efficiency for ONE conversion delivering ac_wh this slot.

        With EOS_INVERTER_EFF_CURVE set: linear interpolation of η over the
        slot-AC utilisation frac = ac_wh / max_power_wh (∈[0,1], i.e. P/Pnenn —
        max_power_wh is already slot-scaled so the ratio is dimensionless).
        Clamped to the outermost curve points. Without a curve: the constant
        parameters.dc_to_ac_efficiency (legacy, byte-identical).
        """
        if not _EFF_CURVE:
            return self.dc_to_ac_efficiency
        cap = self.max_power_wh
        frac = 0.0 if cap <= 0 else min(max(ac_wh / cap, 0.0), 1.0)
        points = _EFF_CURVE
        if frac <= points[0][0]:
            return points[0][1]
        if frac >= points[-1][0]:
            return points[-1][1]
        for i in range(1, len(points)):
            f1, e1 = points[i]
            if frac <= f1:
                f0, e0 = points[i - 1]
                t = (frac - f0) / (f1 - f0) if f1 > f0 else 0.0
                return e0 + t * (e1 - e0)
        return points[-1][1]

    def _ref_eff(self) -> float:
        """Referenz-η für Reserve-/Kapazitäts-Übersetzungen (v2).

        Diese Übersetzungen aggregieren VIELE künftige Nacht-Slots — es gibt
        keine einzelne Konversionsgröße für η. Statt der Konstante (v1) wird η
        am definierten Nacht-Arbeitspunkt bewertet (NIGHT_FRAC × Pnenn), damit
        die AC-Reserve mit realistischem Teillast-η in SoC-Wh übersetzt wird
        (η_night < 1 ⇒ mehr Wh zurückhalten ⇒ Nacht bleibt gedeckt).
        Ohne Kurve: die Konstante (byte-identisches Legacy-Verhalten).
        """
        if not _EFF_CURVE:
            return self.dc_to_ac_efficiency
        return self._dc_ac_eff(_EFF_CURVE_NIGHT_FRAC * self.max_power_wh)

    def process_energy(
        self,
        generation: float,
        consumption: float,
        hour: int,
        export_reserve_ac_wh: float = 0.0,
    ) -> tuple[float, float, float, float]:
        # DVhub fork: export_reserve_ac_wh is the household self-consumption
        # (load − PV) the battery must still cover from AFTER this slot until PV
        # next covers load (i.e. the coming night), expressed as delivered AC
        # energy. Battery→grid EXPORT may not drain the battery below this
        # reserve, so the pack rides the night on self-consumption instead of
        # being sold empty at the evening peak and re-bought from the grid.
        # Self-consumption (covering THIS slot's load) may still use the reserve.
        # 0 (default / feature off / daytime) ⇒ export down to the hard floor.
        losses = 0.0
        grid_export = 0.0
        grid_import = 0.0
        self_consumption = 0.0

        # Cache inverter DC→AC efficiency for discharge path.
        # v2: reserve/capacity translations use the night-operating-point η
        # (curve on) instead of the constant — see _ref_eff docstring.
        dc_to_ac_eff = self._ref_eff()

        if generation >= consumption:
            if consumption > self.max_power_wh:
                # If consumption exceeds maximum inverter power
                losses += generation - self.max_power_wh
                remaining_power = self.max_power_wh - consumption
                grid_import = -remaining_power  # Negative indicates feeding into the grid
                self_consumption = self.max_power_wh
            else:
                # Calculate scr using cached results per energy management/optimization run
                scr = self.self_consumption_predictor.calculate_self_consumption(
                    consumption, generation
                )

                # Remaining power after consumption
                remaining_power = (generation - consumption) * scr  # EVQ
                # Remaining load Self Consumption not perfect
                remaining_load_evq = (generation - consumption) * (1.0 - scr)

                if remaining_load_evq > 0:
                    # Akku muss den Restverbrauch decken
                    if self.battery:
                        # Request more DC from battery to account for DC→AC conversion loss.
                        # Eff-curve: η at THIS conversion's AC size (load-dependent).
                        load_eff = self._dc_ac_eff(remaining_load_evq)
                        dc_request = remaining_load_evq / load_eff
                        from_battery_dc, discharge_losses = self.battery.discharge_energy(
                            dc_request, hour
                        )
                        # Convert DC output to AC
                        from_battery_ac = from_battery_dc * load_eff
                        inverter_discharge_losses = from_battery_dc - from_battery_ac
                        remaining_load_evq -= from_battery_ac
                        losses += discharge_losses + inverter_discharge_losses
                    else:
                        from_battery_ac = 0.0

                    # Wenn der Akku den Restverbrauch nicht vollständig decken kann, wird der Rest ins Netz gezogen
                    if remaining_load_evq > 0:
                        grid_import += remaining_load_evq
                        remaining_load_evq = 0
                else:
                    from_battery_ac = 0.0

                if remaining_power > 0:
                    # Load battery with excess energy (DC path, no inverter conversion needed)
                    charge_losses = 0.0
                    if self.battery:
                        charged_energie, charge_losses = self.battery.charge_energy(
                            remaining_power, hour
                        )
                        remaining_surplus = remaining_power - (charged_energie + charge_losses)
                    else:
                        remaining_surplus = remaining_power

                    # Feed-in to the grid based on remaining capacity
                    if remaining_surplus > self.max_power_wh - consumption:
                        grid_export = self.max_power_wh - consumption
                        losses += remaining_surplus - grid_export
                    else:
                        grid_export = remaining_surplus

                    losses += charge_losses
                self_consumption = (
                    consumption + from_battery_ac
                )  # Self-consumption is equal to the load

                # DVhub fork (2026-05-31): Case-1 battery→grid CO-EXPORT.
                # Vanilla EOS and the Option-B Case-2 fork only let the battery
                # sell to grid when PV < load. But the morning high-price window
                # coincides with the PV ramp (PV ≥ load ⇒ Case 1), locking the
                # battery out of grid export EXACTLY when prices peak — so the GA
                # was forced to dump the battery at the lower evening peak instead
                # of holding it for the (higher) morning. Here the battery may
                # ALSO sell in Case 1, additively, up to the inverter headroom
                # left after PV export, gated by the SAME discharge gene and
                # overnight reserve as Case 2. Charge-vs-discharge stays mutually
                # exclusive via the charge gene (charge_array[hour]==0 when the GA
                # wants to sell ⇒ no slot both charges and discharges). Negative-
                # price curtailment is enforced globally in genetic.py. Shares the
                # EOS_BATTERY_GRID_EXPORT gate with Case 2 (set =0 to revert).
                # Co-export total stays ≤ max_power_wh (the AC grid-connection
                # cap); the battery share is bounded by its own per-slot power cap
                # inside discharge_energy(). Reverts byte-identically when the
                # discharge gene is 0.
                if (
                    _BATTERY_GRID_EXPORT_ENABLED
                    and self.battery
                    and self.battery.discharge_array[hour] > 0
                ):
                    headroom_ac = max(self.max_power_wh - consumption - grid_export, 0.0)
                    disch_eff = self.battery.discharging_efficiency
                    if dc_to_ac_eff > 0 and disch_eff > 0 and export_reserve_ac_wh > 0:
                        soc_reserve_wh = export_reserve_ac_wh / (dc_to_ac_eff * disch_eff)
                    else:
                        soc_reserve_wh = 0.0
                    raw_unreserved_wh = max(
                        self.battery.soc_wh - self.battery.min_soc_wh - soc_reserve_wh,
                        0.0,
                    )
                    ac_unreserved = raw_unreserved_wh * disch_eff * dc_to_ac_eff
                    export_ac = min(ac_unreserved, headroom_ac)
                    if export_ac > 0:
                        # Eff-curve: the co-export rides ON TOP of PV export, so
                        # the marginal utilisation is the TOTAL AC the inverter
                        # moves (consumption + PV export + this export) — η at
                        # that operating point, not at the (small) export alone.
                        exp_eff = self._dc_ac_eff(consumption + grid_export + export_ac)
                        dc_request = export_ac / exp_eff
                        exp_dc, exp_losses = self.battery.discharge_energy(dc_request, hour)
                        exp_ac = exp_dc * exp_eff
                        losses += exp_losses + (exp_dc - exp_ac)
                        grid_export += exp_ac

        else:
            # Case 2: Insufficient generation, cover shortfall
            shortfall = consumption - generation
            available_ac_power = max(self.max_power_wh - generation, 0)

            # Discharge battery to cover shortfall, if possible.
            if self.battery:
                # Two independent decisions this slot:
                #   1. SELF-CONSUMPTION (cover the house load from the battery).
                #      For a fixed-tariff operator the grid import price (26.9 ct)
                #      is ALWAYS higher than any spot feed-in (≤~18 ct), so using
                #      stored energy for the load is unconditionally cheaper than
                #      importing — independent of the day's price level. With
                #      _SELF_CONSUMPTION_PRIORITY on we therefore cover the load
                #      from the battery REGARDLESS of the genetic's discharge gene
                #      (ignore_gate), down to the hard floor. This is what stops
                #      the optimizer from buying the night back from the grid while
                #      the battery still holds charge — robustly, not via a
                #      brittle residual-value threshold tuned to a guessed price.
                #   2. GRID EXPORT (sell surplus). Stays gated by the genetic's
                #      discharge gene AND the overnight reserve: only the genuine
                #      excess (what the battery won't need for self-consumption
                #      before PV refills) is sold, and the GA picks WHEN — i.e. the
                #      highest spot slots, whatever their absolute level.
                # A SINGLE discharge_energy() call enforces the per-slot battery
                # power cap (max_charge_power_w × slot_duration_h) and SoC floor
                # across both roles; `available_ac_power` caps total inverter
                # throughput — so the two never compound past either limit.
                grid_export_allowed = (
                    _BATTERY_GRID_EXPORT_ENABLED
                    and self.battery.discharge_array[hour] > 0
                )
                cover_load = _SELF_CONSUMPTION_PRIORITY or grid_export_allowed
                # Load coverage may always draw down to the hard floor.
                load_ac = min(shortfall, available_ac_power) if cover_load else 0.0
                if grid_export_allowed:
                    # Translate the overnight AC reserve into a SoC floor for the
                    # EXPORT branch, then the deliverable AC from the pool ABOVE
                    # that reserve. Export gets only what's left after load.
                    disch_eff = self.battery.discharging_efficiency
                    if dc_to_ac_eff > 0 and disch_eff > 0 and export_reserve_ac_wh > 0:
                        soc_reserve_wh = export_reserve_ac_wh / (dc_to_ac_eff * disch_eff)
                    else:
                        soc_reserve_wh = 0.0
                    raw_unreserved_wh = max(
                        self.battery.soc_wh - self.battery.min_soc_wh - soc_reserve_wh,
                        0.0,
                    )
                    ac_unreserved = raw_unreserved_wh * disch_eff * dc_to_ac_eff
                    export_ac_cap = max(ac_unreserved - load_ac, 0.0)
                    target_ac = min(load_ac + export_ac_cap, available_ac_power)
                else:
                    target_ac = load_ac
                # Request more DC from battery to account for DC→AC conversion loss.
                # ignore_gate lets self-consumption bypass the discharge gene; when
                # only export is allowed the gene already permits discharge anyway.
                # Eff-curve: the battery discharge shares the inverter with the
                # PV passthrough — utilisation = generation + target_ac.
                dis_eff = self._dc_ac_eff(generation + target_ac)
                dc_request = target_ac / dis_eff
                total_discharge_dc, discharge_losses = self.battery.discharge_energy(
                    dc_request, hour, ignore_gate=cover_load
                )
                # Convert DC output to AC
                total_discharge_ac = total_discharge_dc * dis_eff
                inverter_discharge_losses = total_discharge_dc - total_discharge_ac
                losses += discharge_losses + inverter_discharge_losses

                # Load is covered first; anything beyond the shortfall is exported.
                battery_discharge_ac = min(total_discharge_ac, shortfall)
                grid_export += max(total_discharge_ac - shortfall, 0.0)
            else:
                battery_discharge_ac = 0

            # Draw remaining required power from the grid (discharge_losses are already subtracted in the battery)
            grid_import = shortfall - battery_discharge_ac
            self_consumption = generation + battery_discharge_ac

        return grid_export, grid_import, losses, self_consumption
