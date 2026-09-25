import type { JudgeParsed, Panel } from "../types";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? line + " " + w : w;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) return lines;
    } else {
      line = candidate;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

export interface ShareCardInput {
  question: string;
  panels: { a: Panel; b: Panel };
  judge: JudgeParsed | null;
}

export async function drawShareCard({ question, panels, judge }: ShareCardInput): Promise<string> {
  const W = 1080;
  const H = 1080;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // ground
  ctx.fillStyle = "#1A1B1E";
  ctx.fillRect(0, 0, W, H);

  // header
  ctx.fillStyle = "#F4F2EC";
  ctx.font = "800 64px 'Space Grotesk', 'Arial Black', sans-serif";
  ctx.fillText("GRAPHITE", 60, 96);
  ctx.font = "400 26px 'IBM Plex Mono', 'Courier New', monospace";
  ctx.fillStyle = "#8A8D93";
  ctx.fillText("TWO MODELS · ONE DATASET · ONE CHART", 60, 134);

  // prompt
  ctx.fillStyle = "#C9CBD1";
  ctx.font = "italic 30px Georgia, serif";
  const qLines = wrapText(ctx, `“${question}”`, W - 120, 2);
  qLines.forEach((l, i) => ctx.fillText(l, 60, 190 + i * 40));

  // chart cards
  const cardY = 280;
  const cardW = 470;
  const cardH = 480;
  const labels = ["a", "b"] as const;

  for (let i = 0; i < 2; i++) {
    const x = i === 0 ? 60 : W - 60 - cardW;
    const panel = panels[labels[i]];
    // card
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.roundRect(x, cardY, cardW, cardH, 18);
    ctx.fill();
    // model tag
    ctx.fillStyle = labels[i] === "a" ? "#E8A13C" : "#3F8FE0";
    ctx.font = "700 24px 'IBM Plex Mono', monospace";
    ctx.fillText(`MODEL ${labels[i].toUpperCase()} · ${panel.slot.model.slice(0, 28)}`, x + 20, cardY + 38);
    // chart
    const png = panel.execution?.pngBase64;
    if (png) {
      try {
        const img = await loadImage(`data:image/png;base64,${png}`);
        const pad = 20;
        const availW = cardW - pad * 2;
        const availH = cardH - 80;
        const scale = Math.min(availW / img.width, availH / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, x + (cardW - w) / 2, cardY + 56 + (availH - h) / 2, w, h);
      } catch { /* leave the card blank */ }
    } else {
      ctx.fillStyle = "#B9BBC0";
      ctx.font = "400 22px 'IBM Plex Mono', monospace";
      ctx.fillText(panel.execution?.blocked ? "BLOCKED" : panel.execution?.ok ? "—" : "CRASHED", x + 20, cardY + cardH / 2);
    }
  }

  // verdict strip
  const vy = 810;
  ctx.fillStyle = "#26272B";
  ctx.beginPath();
  ctx.roundRect(60, vy, W - 120, 190, 18);
  ctx.fill();
  ctx.fillStyle = "#8A8D93";
  ctx.font = "700 20px 'IBM Plex Mono', monospace";
  ctx.fillText("JUDGE VERDICT", 90, vy + 40);
  ctx.fillStyle = "#F4F2EC";
  ctx.font = "400 26px Georgia, serif";
  if (judge) {
    const ship = String(judge.ship || "?").toUpperCase();
    const reason = judge.reason || "";
    const lines = wrapText(ctx, reason, W - 180, 2);
    ctx.fillStyle = "#F4F2EC";
    ctx.font = "italic 26px Georgia, serif";
    lines.forEach((l, i) => ctx.fillText(l, 90, vy + 82 + i * 36));
    ctx.fillStyle = "#F4F2EC";
    ctx.font = "800 34px 'Space Grotesk', sans-serif";
    ctx.fillText(`SHIPS: ${ship}`, 90, vy + 168);
    if (judge.a && judge.b) {
      ctx.font = "400 24px 'IBM Plex Mono', monospace";
      ctx.fillStyle = "#8A8D93";
      ctx.fillText(`A ${judge.a.insight}/${judge.a.clarity}   B ${judge.b.insight}/${judge.b.clarity}  (insight/clarity)`, W - 430, vy + 168);
    }
  } else {
    ctx.fillStyle = "#8A8D93";
    ctx.fillText("no verdict", 90, vy + 90);
  }

  return canvas.toDataURL("image/png");
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
