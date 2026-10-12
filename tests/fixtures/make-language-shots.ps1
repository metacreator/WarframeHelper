# Draws one synthetic inventory screenshot per game language (lang-<code>.png) from language-shots.json:
# 12 tiles with the item names warframe.market uses in that language, stack counts, and one refined relic.
#   powershell -ExecutionPolicy Bypass -File make-language-shots.ps1 <folder>
Add-Type -AssemblyName System.Drawing
$out = $args[0]
$spec = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'language-shots.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json

foreach ($lang in $spec.PSObject.Properties) {
  $data = $lang.Value
  $bmp = New-Object System.Drawing.Bitmap 1920, 1080
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::FromArgb(18, 22, 30))
  $hdr = New-Object System.Drawing.Font 'Arial', 26, ([System.Drawing.FontStyle]::Bold)
  $g.DrawString('INVENTORY', $hdr, [System.Drawing.Brushes]::White, 120, 40)
  $nameFont = New-Object System.Drawing.Font $data.font, 15, ([System.Drawing.FontStyle]::Bold)
  $countFont = New-Object System.Drawing.Font 'Arial', 17, ([System.Drawing.FontStyle]::Bold)
  $tile = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(38, 44, 56))
  $art = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(150, 120, 60))
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $i = 0
  foreach ($t in $data.tiles) {
    $x = 120 + ($i % 6) * 280
    $y = 140 + [math]::Floor($i / 6) * 330
    $g.FillRectangle($tile, $x, $y, 260, 300)
    $g.FillEllipse($art, $x + 60, $y + 40, 140, 150)
    if ($t.qty -gt 1) { $g.DrawString([string]$t.qty, $countFont, [System.Drawing.Brushes]::White, $x + 12, $y + 10) }
    $rect = New-Object System.Drawing.RectangleF ($x + 15), ($y + 215), 230, 80
    $g.DrawString($t.text.ToUpperInvariant(), $nameFont, [System.Drawing.Brushes]::White, $rect, $fmt)
    $i++
  }
  $bmp.Save((Join-Path $out "lang-$($lang.Name).png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
'ok'
