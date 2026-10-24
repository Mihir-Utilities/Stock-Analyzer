// Package prices serves price bars and the indicator snapshot (B04, docs/03 section 4).
package prices

import (
	"math"
	"time"
)

// MaxPoints is the most bars one response carries (docs/03 section 4).
const MaxPoints = 2000

// Bar is one OHLCV candle on a market date.
type Bar struct {
	Date                   time.Time
	Open, High, Low, Close float64
	Volume                 int64
}

// Weekly aggregates daily bars (ascending) into ISO-week candles: open of the first, high max, low
// min, close of the last, volume sum. A candle is dated with the last trading day of its week, so
// the final candle always carries the real last bar date. Nothing is forward-filled.
func Weekly(bars []Bar) []Bar {
	var out []Bar
	var curY, curW int
	for i, b := range bars {
		y, w := b.Date.ISOWeek()
		if i == 0 || y != curY || w != curW {
			out = append(out, b)
			curY, curW = y, w
			continue
		}
		c := &out[len(out)-1]
		c.High = math.Max(c.High, b.High)
		c.Low = math.Min(c.Low, b.Low)
		c.Close = b.Close
		c.Volume += b.Volume
		c.Date = b.Date
	}
	return out
}

// LTTB picks `threshold` bars with Largest-Triangle-Three-Buckets on the close; the first and last
// bar are always kept and each chosen point is a real candle (its OHLC is untouched).
func LTTB(bars []Bar, threshold int) []Bar {
	n := len(bars)
	if threshold >= n || threshold < 3 {
		return bars
	}
	out := make([]Bar, 0, threshold)
	out = append(out, bars[0])
	every := float64(n-2) / float64(threshold-2)
	a := 0
	for i := 0; i < threshold-2; i++ {
		// average point of the next bucket
		nextStart := int(math.Floor(float64(i+1)*every)) + 1
		nextEnd := min(int(math.Floor(float64(i+2)*every))+1, n)
		var avgX, avgY float64
		for j := nextStart; j < nextEnd; j++ {
			avgX += float64(j)
			avgY += bars[j].Close
		}
		cnt := float64(nextEnd - nextStart)
		avgX, avgY = avgX/cnt, avgY/cnt

		start := int(math.Floor(float64(i)*every)) + 1
		end := int(math.Floor(float64(i+1)*every)) + 1
		best, bestArea := start, -1.0
		for j := start; j < end; j++ {
			area := math.Abs((float64(a)-avgX)*(bars[j].Close-bars[a].Close)-
				(float64(a)-float64(j))*(avgY-bars[a].Close)) / 2
			if area > bestArea {
				best, bestArea = j, area
			}
		}
		out = append(out, bars[best])
		a = best
	}
	return append(out, bars[n-1])
}

// Reduce enforces MaxPoints: daily bars when they fit, else weekly candles, else LTTB over the
// weekly candles. interval is "1d" or "1w".
func Reduce(daily []Bar) (bars []Bar, interval string) {
	if len(daily) <= MaxPoints {
		return daily, "1d"
	}
	w := Weekly(daily)
	if len(w) > MaxPoints {
		w = LTTB(w, MaxPoints)
	}
	return w, "1w"
}
