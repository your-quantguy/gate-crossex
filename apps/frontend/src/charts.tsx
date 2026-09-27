import { useEffect, useRef } from 'react';
import { AreaSeries, CandlestickSeries, ColorType, createChart, CrosshairMode, HistogramSeries, LineSeries, LineStyle, TickMarkType, type AreaData, type CandlestickData, type IChartApi, type ISeriesApi, type LogicalRange, type Time, type UTCTimestamp } from 'lightweight-charts';
import type { Candle, CandleInterval } from './api.js';
import type { PremiumHistoryPoint } from './premium-history.js';
import type { PriceDifferenceHistoryPoint } from './price-difference-history.js';

type ChartTheme = 'dark' | 'light';

const PALETTES: Record<ChartTheme, { grid: string; label: string; green: string; red: string; volumeUp: string; volumeDown: string; crosshair: string }> = {
  dark: { grid: '#1d2938', label: '#667386', green: '#19d6ae', red: '#f05b72', volumeUp: 'rgba(25, 214, 174, .38)', volumeDown: 'rgba(240, 91, 114, .32)', crosshair: '#3d4c5e' },
  light: { grid: '#dbe3ea', label: '#7a8794', green: '#009b7d', red: '#d74860', volumeUp: 'rgba(0, 155, 125, .35)', volumeDown: 'rgba(215, 72, 96, .3)', crosshair: '#9fb0bd' },
};

const VISIBLE_CANDLES = 96;

function chartText(locale: string, english: string, chinese: string): string {
  return locale.toLowerCase().startsWith('zh') ? chinese : english;
}

interface CandleChartProps {
  candles: Candle[];
  interval: CandleInterval;
  /** Identifies the symbol+interval series so the view resets only when it changes, not on live ticks. */
  seriesKey: string;
  theme: ChartTheme;
  locale: string;
  /** Message shown until the series has enough candles to draw. */
  placeholder: string;
  onHover: (candle: Candle | null) => void;
  onLoadMore: () => void;
}

export function CandleChart({ candles, interval, seriesKey, theme, locale, placeholder, onHover, onLoadMore }: CandleChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const candleByTimeRef = useRef<Map<number, Candle>>(new Map());
  const onHoverRef = useRef(onHover);
  const onLoadMoreRef = useRef(onLoadMore);
  const shownKeyRef = useRef<string | null>(null);
  const precisionRef = useRef<number | null>(null);
  const renderedRef = useRef<{ key: string; theme: ChartTheme; candles: Candle[] } | null>(null);
  onHoverRef.current = onHover;
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, fontFamily: "'Manrope', ui-sans-serif, system-ui, sans-serif", fontSize: 12 },
      grid: { vertLines: { visible: false }, horzLines: { visible: true } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderVisible: false, secondsVisible: false, rightOffset: 3 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const priceSeries = chart.addSeries(CandlestickSeries, { borderVisible: false, priceLineStyle: LineStyle.Dashed });
    const volumeSeries = chart.addSeries(HistogramSeries, { priceScaleId: 'volume', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.subscribeCrosshairMove((param) => {
      const bar = param.seriesData.get(priceSeries) as CandlestickData<UTCTimestamp> | undefined;
      onHoverRef.current(bar ? candleByTimeRef.current.get(bar.time) ?? null : null);
    });
    const handleVisibleRange = (range: LogicalRange | null) => {
      if (!range) return;
      const bars = priceSeries.barsInLogicalRange(range);
      if (bars !== null && bars.barsBefore < 24) onLoadMoreRef.current();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRange);
    chartRef.current = chart;
    priceSeriesRef.current = priceSeries;
    volumeSeriesRef.current = volumeSeries;
    return () => {
      chartRef.current = null;
      priceSeriesRef.current = null;
      volumeSeriesRef.current = null;
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRange);
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const palette = PALETTES[theme];
    chartRef.current?.applyOptions({
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: palette.label },
      grid: { horzLines: { color: palette.grid } },
      localization: { locale },
      timeScale: { timeVisible: interval !== '1d' },
      crosshair: {
        vertLine: { color: palette.crosshair, style: LineStyle.Dashed, labelBackgroundColor: palette.crosshair },
        horzLine: { color: palette.crosshair, style: LineStyle.Dashed, labelBackgroundColor: palette.crosshair },
      },
    });
    priceSeriesRef.current?.applyOptions({ upColor: palette.green, downColor: palette.red, wickUpColor: palette.green, wickDownColor: palette.red });
  }, [theme, locale, interval]);

  useEffect(() => {
    const chart = chartRef.current;
    const priceSeries = priceSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!chart || !priceSeries || !volumeSeries) return;
    const palette = PALETTES[theme];
    // Live ticks arrive several times a second and only ever revise or append the final candle
    // (state updates preserve the identity of untouched candle objects). Feed those through the
    // chart's incremental update path; rebuilding the full series is reserved for a new
    // symbol/timeframe, history prepends, snapshot replacements, or a theme change (per-bar
    // volume colors bake in the palette).
    const previous = renderedRef.current;
    let incremental = previous !== null
      && previous.key === seriesKey
      && previous.theme === theme
      && previous.candles.length > 0
      && candles.length >= previous.candles.length
      && candles.length - previous.candles.length <= 1;
    if (incremental && previous) {
      for (let index = 0; index < candles.length - 1; index += 1) {
        if (candles[index] !== previous.candles[index]) {
          incremental = false;
          break;
        }
      }
    }
    if (incremental) {
      const candle = candles[candles.length - 1];
      const time = Math.floor(candle.startTime / 1000) as UTCTimestamp;
      candleByTimeRef.current.set(time, candle);
      priceSeries.update({
        time,
        open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close),
      });
      volumeSeries.update({
        time,
        value: Number(candle.volume) || 0,
        color: Number(candle.close) >= Number(candle.open) ? palette.volumeUp : palette.volumeDown,
      });
    } else {
      candleByTimeRef.current = new Map(candles.map((candle) => [Math.floor(candle.startTime / 1000), candle]));
      priceSeries.setData(candles.map((candle) => ({
        time: Math.floor(candle.startTime / 1000) as UTCTimestamp,
        open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close),
      })));
      volumeSeries.setData(candles.map((candle) => ({
        time: Math.floor(candle.startTime / 1000) as UTCTimestamp,
        value: Number(candle.volume) || 0,
        color: Number(candle.close) >= Number(candle.open) ? palette.volumeUp : palette.volumeDown,
      })));
    }
    renderedRef.current = { key: seriesKey, theme, candles };
    const lastClose = candles.length ? Number(candles[candles.length - 1].close) : 0;
    const precision = lastClose >= 1000 ? 1 : lastClose >= 1 ? 2 : 6;
    if (precisionRef.current !== precision && lastClose > 0) {
      precisionRef.current = precision;
      priceSeries.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } });
    }
    if (shownKeyRef.current !== seriesKey && candles.length > 1) {
      shownKeyRef.current = seriesKey;
      chart.timeScale().setVisibleLogicalRange({ from: candles.length - VISIBLE_CANDLES, to: candles.length + 3 });
    }
  }, [candles, theme, seriesKey]);

  const last = candles[candles.length - 1];
  const summary = last
    ? `${candles.length} ${interval} candles. Latest open ${last.open}, high ${last.high}, low ${last.low}, close ${last.close}.`
    : `No ${interval} candles available.`;
  return <div className="price-chart">
    <div className="chart-host" ref={hostRef} role="img" aria-label={summary} />
    {candles.length < 2 && <span className="chart-placeholder">{placeholder}</span>}
  </div>;
}

interface HistoryChartPoint {
  time: number;
  value: number;
}

interface HistoryChartProps<T extends HistoryChartPoint> {
  points: T[];
  seriesKey: string;
  visibleDurationMs: number;
  theme: ChartTheme;
  locale: string;
  placeholder: string;
  onHover: (point: T | null) => void;
  onLoadMore: () => void;
}

const PREMIUM_PALETTES: Record<ChartTheme, { grid: string; label: string; line: string; fillTop: string; fillBottom: string; crosshair: string }> = {
  dark: {
    grid: '#1a2524',
    label: '#66756f',
    line: '#b8ff3d',
    fillTop: 'rgba(184, 255, 61, .17)',
    fillBottom: 'rgba(184, 255, 61, .015)',
    crosshair: '#53645f',
  },
  light: {
    grid: '#dce5e1',
    label: '#718079',
    line: '#008f72',
    fillTop: 'rgba(0, 143, 114, .16)',
    fillBottom: 'rgba(0, 143, 114, .015)',
    crosshair: '#91a69f',
  },
};

function chartTimeToLocalDate(time: Time): Date {
  if (typeof time === 'number') return new Date(time * 1000);
  if (typeof time === 'string') return new Date(time);
  return new Date(time.year, time.month - 1, time.day);
}

function SpreadHistoryChart<T extends HistoryChartPoint>({
  points,
  seriesKey,
  visibleDurationMs,
  theme,
  locale,
  placeholder,
  onHover,
  onLoadMore,
  unit,
  ariaLabel,
}: HistoryChartProps<T> & { unit: '%' | ' bps' | ' USD'; ariaLabel: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const pointByTimeRef = useRef<Map<number, T>>(new Map());
  const onHoverRef = useRef(onHover);
  const onLoadMoreRef = useRef(onLoadMore);
  const shownKeyRef = useRef<string | null>(null);
  const oldestTimeRef = useRef<number | null>(null);
  onHoverRef.current = onHover;
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, fontFamily: "'Manrope', ui-sans-serif, system-ui, sans-serif", fontSize: 12 },
      grid: { vertLines: { visible: false }, horzLines: { visible: true } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.16, bottom: 0.14 } },
      timeScale: { borderVisible: false, secondsVisible: false, timeVisible: true, rightOffset: 1 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const series = chart.addSeries(AreaSeries, {
      lineWidth: 2,
      priceLineVisible: true,
      priceLineStyle: LineStyle.Dashed,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
    });
    chart.subscribeCrosshairMove((param) => {
      const datum = param.seriesData.get(series) as AreaData<UTCTimestamp> | undefined;
      onHoverRef.current(datum ? pointByTimeRef.current.get(datum.time) ?? null : null);
    });
    const handleVisibleRange = (range: LogicalRange | null) => {
      if (!range) return;
      const bars = series.barsInLogicalRange(range);
      if (bars !== null && bars.barsBefore < 30) onLoadMoreRef.current();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRange);
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chartRef.current = null;
      seriesRef.current = null;
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRange);
      chart.remove();
    };
  }, []);

  useEffect(() => {
    seriesRef.current?.applyOptions({
      priceFormat: {
        type: 'custom',
        minMove: 0.01,
        formatter: (value: number) => `${value.toFixed(2)}${unit}`,
      },
    });
  }, [unit]);

  useEffect(() => {
    const palette = PREMIUM_PALETTES[theme];
    chartRef.current?.applyOptions({
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: palette.label },
      grid: { horzLines: { color: palette.grid } },
      localization: {
        locale,
        timeFormatter: (time: Time) => chartTimeToLocalDate(time).toLocaleString(locale, {
          month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
        }),
      },
      timeScale: {
        tickMarkFormatter: (time: Time, tickMarkType: TickMarkType) => {
          const date = chartTimeToLocalDate(time);
          return tickMarkType === TickMarkType.Year
            ? date.toLocaleDateString(locale, { year: 'numeric' })
            : tickMarkType === TickMarkType.Month
              ? date.toLocaleDateString(locale, { month: 'short' })
              : tickMarkType === TickMarkType.DayOfMonth
                ? date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
                : date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
        },
      },
      crosshair: {
        vertLine: { color: palette.crosshair, style: LineStyle.Dashed, labelBackgroundColor: palette.crosshair },
        horzLine: { color: palette.crosshair, style: LineStyle.Dashed, labelBackgroundColor: palette.crosshair },
      },
    });
    seriesRef.current?.applyOptions({
      lineColor: palette.line,
      topColor: palette.fillTop,
      bottomColor: palette.fillBottom,
      priceLineColor: palette.line,
      crosshairMarkerBorderColor: palette.line,
      crosshairMarkerBackgroundColor: palette.line,
    });
  }, [theme, locale]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    const nextOldestTime = points[0]?.time ?? null;
    const prepending = oldestTimeRef.current !== null
      && nextOldestTime !== null
      && nextOldestTime < oldestTimeRef.current;
    const visibleRange = prepending ? chart.timeScale().getVisibleRange() : null;
    pointByTimeRef.current = new Map(points.map((point) => [Math.floor(point.time / 1000), point]));
    series.setData(points.map((point) => ({
      time: Math.floor(point.time / 1000) as UTCTimestamp,
      value: point.value,
    })));
    if (shownKeyRef.current !== seriesKey && points.length > 1) {
      shownKeyRef.current = seriesKey;
      const latestTime = points[points.length - 1].time;
      const firstVisibleIndex = Math.max(0, points.findIndex((point) => point.time >= latestTime - visibleDurationMs));
      chart.timeScale().setVisibleLogicalRange({ from: firstVisibleIndex, to: points.length });
    } else if (visibleRange) {
      // Prepending changes logical indexes. Restore the timestamp range so the chart does not
      // jump while an older page is inserted to the left.
      chart.timeScale().setVisibleRange(visibleRange);
    }
    oldestTimeRef.current = nextOldestTime;
  }, [points, seriesKey, visibleDurationMs]);

  const latest = points[points.length - 1];
  const summary = latest
    ? `${ariaLabel}. ${points.length} points. Latest ${latest.value.toFixed(2)}${unit}.`
    : `${ariaLabel}. No data available.`;
  return <div className="premium-history-chart">
    <div className="chart-host" ref={hostRef} role="img" aria-label={summary} />
    {points.length < 2 && <span className="chart-placeholder">{placeholder}</span>}
  </div>;
}

export function PremiumHistoryChart(props: HistoryChartProps<PremiumHistoryPoint>) {
  return <SpreadHistoryChart {...props} unit="%" ariaLabel="Historical ADR premium" />;
}

export function OilSpreadHistoryChart(props: HistoryChartProps<PremiumHistoryPoint>) {
  return <SpreadHistoryChart {...props} unit=" USD" ariaLabel="Historical Brent WTI spread" />;
}

export function OilPricesChart({ points, seriesKey, visibleDurationMs, theme, locale, placeholder, onHover }: Omit<HistoryChartProps<PremiumHistoryPoint>, 'onLoadMore'>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const brentRef = useRef<ISeriesApi<'Line'> | null>(null);
  const wtiRef = useRef<ISeriesApi<'Line'> | null>(null);
  const onHoverRef = useRef(onHover);
  const pointByTimeRef = useRef<Map<number, PremiumHistoryPoint>>(new Map());
  const shownKeyRef = useRef<string | null>(null);
  onHoverRef.current = onHover;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, fontFamily: "'Manrope', ui-sans-serif, system-ui, sans-serif", fontSize: 12 },
      grid: { vertLines: { visible: false }, horzLines: { visible: true } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, secondsVisible: false, timeVisible: true },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const brent = chart.addSeries(LineSeries, { color: '#f5a34c', lineWidth: 2, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } });
    const wti = chart.addSeries(LineSeries, { color: '#887ef1', lineWidth: 2, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } });
    chart.subscribeCrosshairMove((param) => {
      const point = param.seriesData.get(brent) as { time: UTCTimestamp } | undefined;
      onHoverRef.current(point ? pointByTimeRef.current.get(point.time) ?? null : null);
    });
    chartRef.current = chart;
    brentRef.current = brent;
    wtiRef.current = wti;
    return () => { chartRef.current = null; brentRef.current = null; wtiRef.current = null; chart.remove(); };
  }, []);

  useEffect(() => {
    const palette = PREMIUM_PALETTES[theme];
    chartRef.current?.applyOptions({
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: palette.label },
      grid: { horzLines: { color: palette.grid } },
      localization: { locale },
      crosshair: {
        vertLine: { color: palette.crosshair, style: LineStyle.Dashed },
        horzLine: { color: palette.crosshair, style: LineStyle.Dashed },
      },
    });
  }, [theme, locale]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !brentRef.current || !wtiRef.current) return;
    pointByTimeRef.current = new Map(points.map((point) => [Math.floor(point.time / 1000), point]));
    brentRef.current.setData(points.map((point) => ({ time: Math.floor(point.time / 1000) as UTCTimestamp, value: point.adrClose })));
    wtiRef.current.setData(points.map((point) => ({ time: Math.floor(point.time / 1000) as UTCTimestamp, value: point.hedgeClose })));
    if (shownKeyRef.current !== seriesKey && points.length > 1) {
      shownKeyRef.current = seriesKey;
      const latestTime = points[points.length - 1].time;
      const first = Math.max(0, points.findIndex((point) => point.time >= latestTime - visibleDurationMs));
      chart.timeScale().setVisibleLogicalRange({ from: first, to: points.length });
    }
  }, [points, seriesKey, visibleDurationMs]);

  return <div className="oil-prices-chart">
    <div className="chart-host" ref={hostRef} role="img" aria-label={`Brent and WTI prices. ${points.length} aligned points.`} />
    {points.length < 2 && <span className="chart-placeholder">{placeholder}</span>}
  </div>;
}

export function PriceDifferenceHistoryChart(props: HistoryChartProps<PriceDifferenceHistoryPoint>) {
  return <SpreadHistoryChart {...props} unit=" bps" ariaLabel="Historical price difference" />;
}

export interface FundingChartPoint {
  time: number;
  value: number;
}

export interface FundingChartSeries {
  id: string;
  label: string;
  color: string;
  points: FundingChartPoint[];
  style?: 'line' | 'area';
}

function chartColorWithAlpha(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) return color;
  return `rgba(${Number.parseInt(match[1], 16)}, ${Number.parseInt(match[2], 16)}, ${Number.parseInt(match[3], 16)}, ${alpha})`;
}

interface FundingHistoryChartProps {
  series: FundingChartSeries[];
  seriesKey: string;
  theme: ChartTheme;
  locale: string;
  placeholder: string;
  showDataTable?: boolean;
}

/** Multi-venue realized funding chart used by the funding detail workspace. */
export function FundingHistoryChart({
  series,
  seriesKey,
  theme,
  locale,
  placeholder,
  showDataTable = true,
}: FundingHistoryChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRefs = useRef<Array<ISeriesApi<'Line'> | ISeriesApi<'Area'>>>([]);
  const shownKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, fontFamily: "'Manrope', ui-sans-serif, system-ui, sans-serif", fontSize: 12 },
      grid: { vertLines: { visible: false }, horzLines: { visible: true } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderVisible: false, secondsVisible: false, timeVisible: true, rightOffset: 1 },
      crosshair: { mode: CrosshairMode.Normal },
      handleScroll: false,
      handleScale: false,
    });
    chartRef.current = chart;
    return () => {
      chartRef.current = null;
      seriesRefs.current = [];
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const palette = PALETTES[theme];
    chartRef.current?.applyOptions({
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: palette.label },
      grid: { horzLines: { color: palette.grid } },
      localization: {
        locale,
        timeFormatter: (time: Time) => chartTimeToLocalDate(time).toLocaleString(locale, {
          month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
        }),
      },
      timeScale: {
        tickMarkFormatter: (time: Time, tickMarkType: TickMarkType) => {
          const date = chartTimeToLocalDate(time);
          return tickMarkType === TickMarkType.Year
            ? date.toLocaleDateString(locale, { year: 'numeric' })
            : tickMarkType === TickMarkType.Month
              ? date.toLocaleDateString(locale, { month: 'short' })
              : tickMarkType === TickMarkType.DayOfMonth
                ? date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
                : date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
        },
      },
      crosshair: {
        vertLine: { color: palette.crosshair, style: LineStyle.Dashed, labelBackgroundColor: palette.crosshair },
        horzLine: { color: palette.crosshair, style: LineStyle.Dashed, labelBackgroundColor: palette.crosshair },
      },
    });
  }, [theme, locale]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const existing of seriesRefs.current) chart.removeSeries(existing);
    const renderSeries = [...series].sort((left, right) =>
      Number(right.style === 'area') - Number(left.style === 'area'));
    seriesRefs.current = renderSeries.map((item) => {
      const data = item.points.map((point) => ({
        time: Math.floor(point.time / 1_000) as UTCTimestamp,
        value: point.value,
      }));
      const commonOptions = {
        lineWidth: 2 as const,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 4,
        priceFormat: {
          type: 'custom' as const,
          minMove: 0.0001,
          formatter: (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(4)}%`,
        },
      };
      if (item.style === 'area') {
        const area = chart.addSeries(AreaSeries, {
          ...commonOptions,
          lineWidth: 1,
          lineColor: item.color,
          topColor: chartColorWithAlpha(item.color, .28),
          bottomColor: chartColorWithAlpha(item.color, .02),
        });
        area.setData(data);
        return area;
      }
      const line = chart.addSeries(LineSeries, {
        ...commonOptions,
        color: item.color,
      });
      line.setData(data);
      return line;
    });
    if (series.some((item) => item.points.length > 1)) {
      shownKeyRef.current = seriesKey;
      chart.timeScale().fitContent();
    }
  }, [series, seriesKey]);

  const pointCount = series.reduce((total, item) => total + item.points.length, 0);
  const latestRows = series.flatMap((item) => {
    const latest = item.points[item.points.length - 1];
    return latest ? [{ id: item.id, label: item.label, ...latest }] : [];
  });
  const summary = latestRows.length > 0
    ? `Realized funding history by venue. ${latestRows.length} series and ${pointCount} total points.`
    : 'Realized funding history by venue. No data available.';
  return <div className="funding-history-chart">
    <div className="chart-host" ref={hostRef} role="img" aria-label={summary} />
    {pointCount < 2 && <span className="chart-placeholder">{placeholder}</span>}
    {showDataTable && latestRows.length > 0 && <details className="chart-data">
      <summary>{chartText(locale, 'View latest funding data', '查看最新资金费率数据')}</summary>
      <table>
        <thead><tr>
          <th>{chartText(locale, 'Series', '数据系列')}</th><th>{chartText(locale, 'Time', '时间')}</th>
          <th>{chartText(locale, 'Value', '数值')}</th>
        </tr></thead>
        <tbody>{latestRows.map((row) => <tr key={row.id}>
          <td>{row.label}</td><td>{new Date(row.time).toLocaleString(locale)}</td>
          <td>{row.value >= 0 ? '+' : ''}{row.value.toFixed(4)}%</td>
        </tr>)}</tbody>
      </table>
    </details>}
  </div>;
}
