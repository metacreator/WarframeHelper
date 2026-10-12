Add-Type -AssemblyName System.Drawing
$out = $args[0]

$rows = @(
  @(@('Ash Prime Systems Blueprint', 2), @('Soma Prime Barrel', 1), @('Redeemer Prime Blade', 3), @('Primed Continuity', 1), @('Serration', 2), @('Axi A1 Relic', 1)),
  @(@('Nikana Prime Hilt', 1), @('Mesa Prime Neuroptics Blueprint', 1), @('Arcane Energize', 1), @('Rhino Prime Chassis Blueprint', 2), @('Braton Prime Receiver', 1), @('Volt Prime Blueprint', 1)),
  @(@('Vitality', 4), @('Hornet Strike', 1), @('Paris Prime Grip', 1), @('Lex Prime Barrel', 2), @('Galatine Prime Blade', 1), @('Trinity Prime Systems Blueprint', 1))
)

function Draw-Shot($file, $rowIdx) {
  $bmp = New-Object System.Drawing.Bitmap 1920, 1080
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::FromArgb(18, 22, 30))
  $hdr = New-Object System.Drawing.Font 'Arial', 26, ([System.Drawing.FontStyle]::Bold)
  $g.DrawString('INVENTORY', $hdr, [System.Drawing.Brushes]::White, 120, 40)
  $nameFont = New-Object System.Drawing.Font 'Arial', 15, ([System.Drawing.FontStyle]::Bold)
  $countFont = New-Object System.Drawing.Font 'Arial', 17, ([System.Drawing.FontStyle]::Bold)
  $tile = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(38, 44, 56))
  $art = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(150, 120, 60))
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $y = 140
  foreach ($r in $rowIdx) {
    $x = 120
    foreach ($it in $rows[$r]) {
      $g.FillRectangle($tile, $x, $y, 260, 300)
      $g.FillEllipse($art, $x + 60, $y + 40, 140, 150)
      if ($it[1] -gt 1) { $g.DrawString([string]$it[1], $countFont, [System.Drawing.Brushes]::White, $x + 12, $y + 10) }
      $rect = New-Object System.Drawing.RectangleF ($x + 15), ($y + 215), 230, 80
      $g.DrawString($it[0].ToUpper(), $nameFont, [System.Drawing.Brushes]::White, $rect, $fmt)
      $x += 280
    }
    $y += 330
  }
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

Draw-Shot (Join-Path $out 'shotA.png') @(0, 1)
Draw-Shot (Join-Path $out 'shotB.png') @(1, 2)
'ok'
