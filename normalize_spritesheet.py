#!/usr/bin/env python3

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass
from pathlib import Path

from PIL import Image


@dataclass(frozen=True)
class SpriteSheetLayout:
    cell_width: int
    cell_height: int
    columns: int
    rows: int

    @property
    def required_width(self) -> int:
        return self.cell_width * self.columns

    @property
    def required_height(self) -> int:
        return self.cell_height * self.rows

    def validate(self, image: Image.Image) -> None:
        if image.width < self.required_width or image.height < self.required_height:
            raise ValueError(
                "Sprite sheet is smaller than the declared grid: "
                f"got {image.width}x{image.height}, need at least "
                f"{self.required_width}x{self.required_height}."
            )

    def cell_box(self, column: int, row: int) -> tuple[int, int, int, int]:
        left = column * self.cell_width
        top = row * self.cell_height
        return (left, top, left + self.cell_width, top + self.cell_height)


@dataclass(frozen=True)
class FrameAnalysis:
    mean: float
    std: float
    count: int
    histogram: tuple[int, ...]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Normalize brightness and contrast across a sprite sheet by matching "
            "each frame to a reference frame."
        )
    )
    parser.add_argument("input", type=Path, help="Source sprite sheet image.")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Output image path. Defaults to <input>_normalized.<ext>.",
    )
    parser.add_argument("--cell-width", type=int, default=256)
    parser.add_argument("--cell-height", type=int, default=256)
    parser.add_argument("--columns", type=int, default=12)
    parser.add_argument("--rows", type=int, default=6)
    parser.add_argument(
        "--reference-mode",
        choices=("row-first", "sheet-first"),
        default="row-first",
        help=(
            "row-first uses the first frame of each row as its reference; "
            "sheet-first uses the top-left frame for the whole sheet."
        ),
    )
    parser.add_argument(
        "--method",
        choices=("stats", "histogram"),
        default="stats",
        help=(
            "stats matches luminance mean/std; histogram is stronger and matches "
            "the luminance distribution more aggressively."
        ),
    )
    parser.add_argument(
        "--strength",
        type=float,
        default=1.0,
        help="Blend factor between original and normalized frame, from 0.0 to 1.0.",
    )
    parser.add_argument(
        "--alpha-threshold",
        type=int,
        default=8,
        help="Ignore pixels with alpha below this value when measuring frames.",
    )
    args = parser.parse_args()
    if not 0.0 <= args.strength <= 1.0:
        parser.error("--strength must be between 0.0 and 1.0")
    if not 0 <= args.alpha_threshold <= 255:
        parser.error("--alpha-threshold must be between 0 and 255")
    return args


def clamp_byte(value: float) -> int:
    return max(0, min(255, int(round(value))))


def analyze_frame(frame: Image.Image, alpha_threshold: int) -> FrameAnalysis:
    rgba = frame.convert("RGBA")
    histogram = [0] * 256
    total = 0.0
    total_sq = 0.0
    count = 0

    for red, green, blue, alpha in rgba.getdata():
        if alpha < alpha_threshold:
            continue
        luminance = clamp_byte(0.2126 * red + 0.7152 * green + 0.0722 * blue)
        histogram[luminance] += 1
        total += luminance
        total_sq += luminance * luminance
        count += 1

    if count == 0:
        return FrameAnalysis(mean=0.0, std=0.0, count=0, histogram=tuple(histogram))

    mean = total / count
    variance = max(0.0, (total_sq / count) - (mean * mean))
    return FrameAnalysis(mean=mean, std=math.sqrt(variance), count=count, histogram=tuple(histogram))


def build_stats_lut(source: FrameAnalysis, reference: FrameAnalysis, strength: float) -> list[int]:
    gain = reference.std / max(source.std, 1.0)
    gain = min(max(gain, 0.35), 3.0)

    lut: list[int] = []
    for value in range(256):
        mapped = ((value - source.mean) * gain) + reference.mean
        blended = value + ((mapped - value) * strength)
        lut.append(clamp_byte(blended))
    return lut


def build_histogram_lut(source: FrameAnalysis, reference: FrameAnalysis, strength: float) -> list[int]:
    if source.count == 0 or reference.count == 0:
        return list(range(256))

    ref_cdf: list[float] = []
    ref_cumulative = 0
    for bucket in reference.histogram:
        ref_cumulative += bucket
        ref_cdf.append(ref_cumulative / reference.count)

    lut: list[int] = []
    src_cumulative = 0
    ref_index = 0
    for value, bucket in enumerate(source.histogram):
        src_cumulative += bucket
        target = src_cumulative / source.count
        while ref_index < 255 and ref_cdf[ref_index] < target:
            ref_index += 1
        blended = value + ((ref_index - value) * strength)
        lut.append(clamp_byte(blended))
    return lut


def apply_luminance_lut(frame: Image.Image, lut: list[int], alpha_threshold: int) -> Image.Image:
    rgba = frame.convert("RGBA")
    rgb = rgba.convert("RGB")
    y_channel, cb_channel, cr_channel = rgb.convert("YCbCr").split()
    alpha_channel = rgba.getchannel("A")

    y_values = list(y_channel.getdata())
    alpha_values = list(alpha_channel.getdata())
    adjusted_values = [
        lut[value] if alpha >= alpha_threshold else value
        for value, alpha in zip(y_values, alpha_values)
    ]

    adjusted_y = Image.new("L", rgba.size)
    adjusted_y.putdata(adjusted_values)
    adjusted_rgb = Image.merge("YCbCr", (adjusted_y, cb_channel, cr_channel)).convert("RGB")
    adjusted_rgb.putalpha(alpha_channel)
    return adjusted_rgb


def normalize_frame(
    frame: Image.Image,
    reference: FrameAnalysis,
    method: str,
    strength: float,
    alpha_threshold: int,
) -> Image.Image:
    source = analyze_frame(frame, alpha_threshold)
    if source.count == 0 or reference.count == 0:
        return frame.copy()

    if method == "histogram":
        lut = build_histogram_lut(source, reference, strength)
    else:
        lut = build_stats_lut(source, reference, strength)
    return apply_luminance_lut(frame, lut, alpha_threshold)


def default_output_path(input_path: Path) -> Path:
    suffix = input_path.suffix or ".png"
    return input_path.with_name(f"{input_path.stem}_normalized{suffix}")


def main() -> int:
    args = parse_args()
    layout = SpriteSheetLayout(
        cell_width=args.cell_width,
        cell_height=args.cell_height,
        columns=args.columns,
        rows=args.rows,
    )

    with Image.open(args.input) as source_image:
        layout.validate(source_image)
        keep_alpha = "A" in source_image.getbands() or "transparency" in source_image.info
        source_rgba = source_image.convert("RGBA")
        output_rgba = source_rgba.copy()

        sheet_reference = None
        if args.reference_mode == "sheet-first":
            sheet_reference = analyze_frame(source_rgba.crop(layout.cell_box(0, 0)), args.alpha_threshold)

        processed_frames = 0
        for row in range(layout.rows):
            row_reference = sheet_reference
            if row_reference is None:
                row_reference = analyze_frame(
                    source_rgba.crop(layout.cell_box(0, row)),
                    args.alpha_threshold,
                )

            for column in range(layout.columns):
                box = layout.cell_box(column, row)
                frame = source_rgba.crop(box)

                if column == 0 and args.reference_mode == "row-first":
                    normalized = frame
                elif row == 0 and column == 0 and args.reference_mode == "sheet-first":
                    normalized = frame
                else:
                    normalized = normalize_frame(
                        frame=frame,
                        reference=row_reference,
                        method=args.method,
                        strength=args.strength,
                        alpha_threshold=args.alpha_threshold,
                    )

                output_rgba.paste(normalized, box)
                processed_frames += 1

        output_path = args.output or default_output_path(args.input)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        final_image = output_rgba if keep_alpha else output_rgba.convert("RGB")
        final_image.save(output_path)

    print(
        f"Saved {processed_frames} frames to {output_path} "
        f"using {args.reference_mode} reference mode and {args.method} matching."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())