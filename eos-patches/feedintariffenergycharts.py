"""Feed-in tariff sourced from EPEX spot price (Spot-Vermarktung / DV-Vermarktung).

EOS upstream (akkudoktor) doesn't ship a FeedInTariffEnergyCharts provider —
operators on dynamic feed-in (German "Spot-Vermarktung") are forced to choose
between FeedInTariffFixed (one static cent value forever) or FeedInTariffImport
(self-managed file). Neither matches how DV-Vermarktung actually works: feed-in
revenue = EPEX day-ahead spot × broker fee factor (typically 0.95–1.00).

This provider reads the elecprice_marketprice_wh series that
ElecPriceEnergyCharts has already populated, multiplies by an operator-set
factor, and writes the result to feed_in_tariff_wh. No second HTTP fetch —
zero extra load on energy-charts.info — runtime-dep on ElecPriceEnergyCharts
being a configured (or co-running) provider.

DVhub fork addition 2026-05-24 — see eos-patches/README.md for the apply
flow and the upstream reasoning.
"""
from typing import Optional

from loguru import logger
from pydantic import Field

from akkudoktoreos.config.configabc import SettingsBaseModel
from akkudoktoreos.prediction.feedintariffabc import FeedInTariffProvider


class FeedInTariffEnergyChartsCommonSettings(SettingsBaseModel):
    """Settings for EnergyCharts-derived dynamic feed-in tariff."""

    spot_factor: Optional[float] = Field(
        default=1.0,
        ge=0.0,
        le=2.0,
        json_schema_extra={
            "description": (
                "Multiplier applied to EPEX spot price for feed-in revenue. "
                "Spot-Vermarktung in DE typically yields 0.95–1.00× the spot."
            ),
            "examples": [1.0, 0.97],
        },
    )


class FeedInTariffEnergyCharts(FeedInTariffProvider):
    """Spot-dynamic feed-in tariff — mirrors elecprice × factor."""

    @classmethod
    def provider_id(cls) -> str:
        return "FeedInTariffEnergyCharts"

    def _update_data(self, force_update: Optional[bool] = False) -> None:
        # Late import: prediction container is constructed at module import
        # time and the elec provider singleton must already exist.
        from akkudoktoreos.core.coreabc import get_prediction
        elec = get_prediction().provider_by_id("ElecPriceEnergyCharts")
        if elec is None:
            logger.error(
                "FeedInTariffEnergyCharts: ElecPriceEnergyCharts provider is "
                "not registered — feed-in series cannot be derived. Configure "
                "elecprice.provider='ElecPriceEnergyCharts' or switch to a "
                "different feedintariff provider."
            )
            return
        # Force the elec provider to refresh first so we mirror today's data,
        # not yesterday's cached series. The PredictionContainer ordering in
        # prediction.py puts elec providers before feedintariff so under normal
        # operation this is a no-op, but force_update through this path covers
        # the manual /v1/prediction/update reload case.
        try:
            elec.update_data(force_update=force_update)
        except Exception as e:
            logger.error(f"FeedInTariffEnergyCharts: elec.update_data failed: {e}")
            return

        cfg_settings = (
            self.config.feedintariff.provider_settings.FeedInTariffEnergyCharts
            if self.config.feedintariff.provider_settings else None
        )
        factor = (cfg_settings.spot_factor if cfg_settings else None) or 1.0

        # DVhub fork: ElecPriceEnergyCharts._parse_data adds charges_kwh and VAT
        # to its series when elecprice.charges_kwh > 0 (DV operators use this to
        # surface the real-world Bezugskosten so the genetic algo doesn't think
        # buy-price ≈ sell-price). Feed-in stays SPOT — so we reverse-engineer:
        #   spot_wh = price_wh / vat_rate − charges_wh   (when charges > 0)
        # At charges_kwh=0 this is a no-op and behaviour is unchanged.
        charges_wh = (self.config.elecprice.charges_kwh or 0) / 1000
        vat_rate = (self.config.elecprice.vat_rate or 1.19) if charges_wh > 0 else 1.0

        # Iterate the elec provider's per-slot records and mirror each spot
        # price into feed_in_tariff_wh × factor. Both series share the same
        # storage backend (PredictionDataRecord) so this is a constant-time
        # value-write per slot.
        mirrored = 0
        for record in elec:
            price_wh = getattr(record, "elecprice_marketprice_wh", None)
            if price_wh is None:
                continue
            # Unwind charges+VAT to recover the pure spot price.
            spot_wh = price_wh / vat_rate - charges_wh if charges_wh > 0 else price_wh
            self.update_value(record.date_time, "feed_in_tariff_wh", spot_wh * factor)
            mirrored += 1
        logger.debug(
            f"FeedInTariffEnergyCharts: mirrored {mirrored} slots, "
            f"factor={factor}, charges_kwh={charges_wh*1000}, vat_rate={vat_rate}"
        )
