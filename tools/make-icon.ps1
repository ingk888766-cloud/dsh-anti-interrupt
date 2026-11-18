# 生成 dsh-anti-interrupt 图标：夜（新月） + 续（开口回环箭头）
# 设计意图：被打断的地方，箭头从缺口接回来。
Add-Type -AssemblyName System.Drawing

function New-Icon([int]$S, [string]$outPath) {
    $k = $S / 512.0
    $bmp = New-Object System.Drawing.Bitmap($S, $S)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)

    # --- 圆角方形底 ---
    $r = [int](112 * $k)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
    $path.AddArc($S - $r * 2, 0, $r * 2, $r * 2, 270, 90)
    $path.AddArc($S - $r * 2, $S - $r * 2, $r * 2, $r * 2, 0, 90)
    $path.AddArc(0, $S - $r * 2, $r * 2, $r * 2, 90, 90)
    $path.CloseFigure()
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Point(0, 0)),
        (New-Object System.Drawing.Point($S, $S)),
        [System.Drawing.Color]::FromArgb(255, 22, 32, 54),
        [System.Drawing.Color]::FromArgb(255, 9, 14, 24))
    $g.FillPath($bg, $path)

    $cx = $S / 2.0
    $cy = $S / 2.0
    $amber = [System.Drawing.Color]::FromArgb(255, 255, 201, 97)

    # --- 中心柔光（很淡，只让月亮离开底色） ---
    $gr = 172 * $k
    $glowRect = New-Object System.Drawing.RectangleF(($cx - $gr), ($cy - $gr), (2 * $gr), (2 * $gr))
    $glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $glowPath.AddEllipse($glowRect)
    $pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowPath)
    $pgb.CenterColor = [System.Drawing.Color]::FromArgb(30, 255, 200, 97)
    $pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 200, 97))
    $g.FillPath($pgb, $glowPath)

    # --- 回环箭头（缺口在右侧） ---
    $rr = 156 * $k
    $pw = 25 * $k
    $bbox = New-Object System.Drawing.RectangleF(($cx - $rr), ($cy - $rr), (2 * $rr), (2 * $rr))
    $pen = New-Object System.Drawing.Pen($amber, [float]$pw)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Flat
    $startAngle = 30.0
    $sweep = 295.0
    $g.DrawArc($pen, $bbox, [float]$startAngle, [float]$sweep)

    # --- 箭头（弧末端，沿切线推进缺口） ---
    $endDeg = $startAngle + $sweep
    $rad = $endDeg * [Math]::PI / 180.0
    $px = $cx + $rr * [Math]::Cos($rad)
    $py = $cy + $rr * [Math]::Sin($rad)
    $tx = -[Math]::Sin($rad)
    $ty = [Math]::Cos($rad)
    $len = 2.05 * $pw
    $half = 0.90 * $pw
    $tipX = $px + $tx * $len * 0.55
    $tipY = $py + $ty * $len * 0.55
    $baseX = $px - $tx * $len * 0.45
    $baseY = $py - $ty * $len * 0.45
    $perpX = -$ty
    $perpY = $tx
    $pts = @(
        (New-Object System.Drawing.PointF([float]$tipX, [float]$tipY)),
        (New-Object System.Drawing.PointF([float]($baseX + $perpX * $half), [float]($baseY + $perpY * $half))),
        (New-Object System.Drawing.PointF([float]($baseX - $perpX * $half), [float]($baseY - $perpY * $half)))
    )
    $ab = New-Object System.Drawing.SolidBrush($amber)
    $g.FillPolygon($ab, [System.Drawing.PointF[]]$pts)

    # --- 新月：区域相减，边缘干净 ---
    $mr = 119 * $k
    $mx = $cx + 7 * $k
    $big = New-Object System.Drawing.Drawing2D.GraphicsPath
    $big.AddEllipse(($mx - $mr), ($cy - $mr), (2 * $mr), (2 * $mr))
    $cut = New-Object System.Drawing.Drawing2D.GraphicsPath
    $ox = 62 * $k
    $oy = -32 * $k
    $cut.AddEllipse(($mx - $mr + $ox), ($cy - $mr + $oy), (2 * $mr), (2 * $mr))
    $region = New-Object System.Drawing.Region($big)
    $region.Exclude($cut)
    $g.FillRegion($ab, $region)

    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
}

$dir = 'C:\Users\OQY\Desktop\dsh-nightwatch\dsh-nightwatch\assets'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
New-Icon 512 (Join-Path $dir 'icon.png')
New-Icon 180 (Join-Path $dir 'icon-180.png')
Get-ChildItem $dir -Filter '*.png' | Select-Object Name, Length | Format-Table -AutoSize | Out-String -Width 60


