<#
  theme-steampunk-geometric.ps1 — hand-built brass Steampunk theme (no library).
  Generates original parametric SVGs (pipe frame + corner gears + rivets, a top-centre gauge,
  riveted-metal toggles, brass buttons, gear slider thumb, ambient cogs) into
  public/theme-assets/steampunk/ and wires THEME_SKINS.steampunk. See scripts/THEME-SKINS.md.
  Uses frameFront (frame on ::after, uncut) + topOrnament (the gauge on ::before).
#>
$ErrorActionPreference='Stop'
$repo='C:\Users\mtown\OneDrive\Documents\GitHub\psychic-disco'
$out=Join-Path $repo 'public\theme-assets\steampunk'
if(Test-Path $out){ Get-ChildItem $out -File | ForEach-Object { [System.IO.File]::Delete($_.FullName) } } else { New-Item -ItemType Directory -Force -Path $out | Out-Null }
$ci=[System.Globalization.CultureInfo]::InvariantCulture
function N($v){ return [string]::Format($ci,'{0:0.##}',$v) }
$defs="<defs><linearGradient id='bv' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#f6da8f'/><stop offset='.42' stop-color='#c98d2c'/><stop offset='1' stop-color='#6f460f'/></linearGradient><linearGradient id='bh' x1='0' y1='0' x2='1' y2='0'><stop offset='0' stop-color='#f6da8f'/><stop offset='.5' stop-color='#c98d2c'/><stop offset='1' stop-color='#6f460f'/></linearGradient><radialGradient id='br' cx='.38' cy='.34' r='.75'><stop offset='0' stop-color='#f9e2a4'/><stop offset='.6' stop-color='#c2842a'/><stop offset='1' stop-color='#6f460f'/></radialGradient></defs>"
function Rivet($x,$y){ return "<circle cx='$(N $x)' cy='$(N $y)' r='2.4' fill='#5e3b0e'/><circle cx='$(N $x)' cy='$(N ($y-0.7))' r='1' fill='#ffe9b0'/>" }
function GearPath($cx,$cy,$ro,$ri,$teeth){
  $step=2*[math]::PI/$teeth; $pts=New-Object System.Collections.Generic.List[string]
  for($i=0;$i -lt $teeth;$i++){ $a=$i*$step
    foreach($f in @(0.0,0.12,0.38,0.5)){ $r= if($f -eq 0.0 -or $f -eq 0.5){$ri}else{$ro}; $ang=$a+$step*$f
      $pts.Add(("{0},{1}" -f (N ($cx+$r*[math]::Cos($ang))),(N ($cy+$r*[math]::Sin($ang))))) } }
  return 'M'+($pts -join ' L')+' Z'
}
function Gear($cx,$cy,$ro,$teeth){
  $ri=$ro*0.78; $hub=$ro*0.42
  $g="<path d='$(GearPath $cx $cy $ro $ri $teeth)' fill='url(#br)' stroke='#4a2f0c' stroke-width='1.4' stroke-linejoin='round'/>"
  $g+="<circle cx='$(N $cx)' cy='$(N $cy)' r='$(N $hub)' fill='#8a5a1a' stroke='#4a2f0c' stroke-width='1.2'/>"
  $g+="<circle cx='$(N $cx)' cy='$(N $cy)' r='$(N ($hub*0.4))' fill='#3a2510'/>"
  for($k=0;$k -lt 5;$k++){ $ang=$k*2*[math]::PI/5; $bx=$cx+($hub*0.72)*[math]::Cos($ang); $by=$cy+($hub*0.72)*[math]::Sin($ang); $g+="<circle cx='$(N $bx)' cy='$(N $by)' r='1' fill='#3a2510'/>" }
  return $g
}
function GearSvg($size,$teeth){ return "<svg xmlns='http://www.w3.org/2000/svg' width='$size' height='$size' viewBox='0 0 $size $size'>$defs"+(Gear ($size/2) ($size/2) ($size*0.42) $teeth)+"</svg>" }
# ── FRAME: brass pipe (9-slice) + corner gears + rivets ──
$corners=@(@(30,30),@(130,30),@(30,130),@(130,130))
$gears=''; foreach($c in $corners){ $gears+= (Gear $c[0] $c[1] 15 11) + (Gear ($c[0]+15) ($c[1]+15) 8 8) }
$riv=''; foreach($c in $corners){ $riv+= (Rivet ($c[0]-9) ($c[1]-9)) }
$frame="<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'>$defs"+
 "<rect x='26' y='26' width='108' height='108' rx='18' fill='none' stroke='#241608' stroke-width='24'/>"+
 "<rect x='26' y='26' width='108' height='108' rx='18' fill='none' stroke='url(#bv)' stroke-width='16'/>"+
 "<rect x='26' y='26' width='108' height='108' rx='18' fill='none' stroke='#ffe6ab' stroke-width='2.4' opacity='.45'/>"+
 $gears+$riv+"</svg>"
# ── GAUGE ──
$ticks=''; for($i=0;$i -le 10;$i++){ $ang=[math]::PI*(0.75+1.5*$i/10); $ticks+="<line x1='$(N (30+18*[math]::Cos($ang)))' y1='$(N (30+18*[math]::Sin($ang)))' x2='$(N (30+22*[math]::Cos($ang)))' y2='$(N (30+22*[math]::Sin($ang)))' stroke='#3a2510' stroke-width='1.4'/>" }
$nang=[math]::PI*(0.75+1.5*0.68); $nx=30+16*[math]::Cos($nang); $ny=30+16*[math]::Sin($nang)
$grv=''; for($i=0;$i -lt 8;$i++){ $ang=$i*[math]::PI/4; $grv+= (Rivet (30+25*[math]::Cos($ang)) (30+25*[math]::Sin($ang))) }
$gauge="<svg xmlns='http://www.w3.org/2000/svg' width='60' height='60' viewBox='0 0 60 60'>$defs"+
 "<circle cx='30' cy='30' r='28' fill='url(#br)' stroke='#241608' stroke-width='2.5'/><circle cx='30' cy='30' r='22' fill='#ece0c4' stroke='#7a4e12' stroke-width='1.6'/>"+
 $ticks+"<line x1='30' y1='30' x2='$(N $nx)' y2='$(N $ny)' stroke='#7a1f12' stroke-width='2.2'/><circle cx='30' cy='30' r='3' fill='#3a2510'/>"+$grv+"</svg>"
# ── TOGGLE ──
function Toggle($on){
  $kx= if($on){48}else{16}; $kf= if($on){'url(#br)'}else{'#9a7433'}; $ind= if($on){"<circle cx='16' cy='16' r='2.6' fill='#8fd14f'/>"}else{''}
  return "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='32' viewBox='0 0 64 32' preserveAspectRatio='none'>$defs"+
   "<rect x='1.5' y='2' width='61' height='28' rx='5' fill='url(#bh)' stroke='#241608' stroke-width='2'/><rect x='6' y='11' width='52' height='10' rx='5' fill='#3a2510' opacity='.55'/>"+$ind+
   (Rivet 7 7)+(Rivet 57 7)+(Rivet 7 25)+(Rivet 57 25)+"<circle cx='$kx' cy='16' r='9' fill='$kf' stroke='#241608' stroke-width='1.6'/><circle cx='$kx' cy='16' r='2' fill='#3a2510'/></svg>"
}
# ── BUTTONS ──
function Button($fill,$stroke){ return "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='40' viewBox='0 0 100 40' preserveAspectRatio='none'>$defs<path d='M4 20 V8 L10 3 H90 L96 8 V32 L90 37 H10 L4 32 Z' fill='$fill' stroke='$stroke' stroke-width='2'/>"+(Rivet 11 9)+(Rivet 89 9)+(Rivet 11 31)+(Rivet 89 31)+"</svg>" }
$input="<svg xmlns='http://www.w3.org/2000/svg' width='100' height='30' viewBox='0 0 100 30' preserveAspectRatio='none'>$defs<rect x='2' y='2' width='96' height='26' rx='4' fill='#2a1a0e' stroke='url(#bh)' stroke-width='2'/>"+(Rivet 8 6)+(Rivet 92 6)+(Rivet 8 24)+(Rivet 92 24)+"</svg>"
$cbE="<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>$defs<rect x='3' y='3' width='18' height='18' rx='3' fill='#2a1a0e' stroke='url(#bv)' stroke-width='2'/></svg>"
$cbC="<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>$defs<rect x='3' y='3' width='18' height='18' rx='3' fill='#3a2510' stroke='url(#bv)' stroke-width='2'/><path d='M7 12 L11 16 L18 7' fill='none' stroke='#f6da8f' stroke-width='2.4'/></svg>"
$badge="<svg xmlns='http://www.w3.org/2000/svg' width='80' height='28' viewBox='0 0 80 28' preserveAspectRatio='none'>$defs<path d='M2 14 V6 L7 2 H73 L78 6 V22 L73 26 H7 L2 22 Z' fill='url(#bh)' stroke='#241608' stroke-width='1.4'/></svg>"
$panel="<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120' preserveAspectRatio='none'>$defs<rect x='4' y='4' width='112' height='112' rx='8' fill='#241608' stroke='url(#bv)' stroke-width='3'/></svg>"
$thumb="<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>$defs"+(Gear 12 12 10 8)+"</svg>"
$files=@{ 'frame.svg'=$frame; 'gauge.svg'=$gauge; 'toggle-off.svg'=(Toggle $false); 'toggle-on.svg'=(Toggle $true);
 'button.svg'=(Button '#9a6a24' '#241608'); 'button-primary.svg'=(Button 'url(#bv)' '#241608'); 'button-danger.svg'=(Button '#8a3a1e' '#241608');
 'input.svg'=$input; 'checkbox-empty.svg'=$cbE; 'checkbox-checked.svg'=$cbC; 'badge.svg'=$badge; 'panel.svg'=$panel; 'thumb.svg'=$thumb;
 'fx-cog-a.svg'=(GearSvg 22 10); 'fx-cog-b.svg'=(GearSvg 20 8); 'fx-cog-c.svg'=(GearSvg 24 12) }
foreach($k in $files.Keys){ [System.IO.File]::WriteAllText((Join-Path $out $k), $files[$k], (New-Object System.Text.UTF8Encoding($false))) }
# ── wire THEME_SKINS.steampunk ──
$ub='theme-assets/steampunk/'
$entry='THEME_SKINS.steampunk={frameFront:true,frame:{url:"'+$ub+'frame.svg",slice:48,repeat:"stretch",width:30,outset:6},'+
 'topOrnament:{url:"'+$ub+'gauge.svg",size:58},'+
 'controls:{btn:{url:"'+$ub+'button.svg",text:"#f4e6c8"},btnPrimary:{url:"'+$ub+'button-primary.svg",text:"#3a2510"},'+
 'btnDanger:{url:"'+$ub+'button-danger.svg",text:"#ffe0d0"},toggleOff:{url:"'+$ub+'toggle-off.svg"},toggleOn:{url:"'+$ub+'toggle-on.svg"},'+
 'input:{url:"'+$ub+'input.svg"},checkboxEmpty:{url:"'+$ub+'checkbox-empty.svg"},checkboxChecked:{url:"'+$ub+'checkbox-checked.svg"},'+
 'badge:{url:"'+$ub+'badge.svg",text:"#3a2510"},panel:{url:"'+$ub+'panel.svg"},sliderThumb:{url:"'+$ub+'thumb.svg"}},'+
 'emoji:["'+$ub+'fx-cog-a.svg","'+$ub+'fx-cog-b.svg","'+$ub+'fx-cog-c.svg"]};'
$tsPath=Join-Path $repo 'public\theme-skins.js'
$t=[System.IO.File]::ReadAllText($tsPath)
$rx=[regex]::new('THEME_SKINS\.steampunk=\{.*?\};',[System.Text.RegularExpressions.RegexOptions]::Singleline)
$t=$rx.Replace($t,'')
$marker='/*__THEME_SKINS__*/'; $at=$t.IndexOf($marker)+$marker.Length
$t=$t.Substring(0,$at)+"`n"+$entry+$t.Substring($at)
[System.IO.File]::WriteAllText($tsPath,$t,(New-Object System.Text.UTF8Encoding($false)))
Write-Host ("steampunk: " + $files.Count + " svgs, entry len=" + $entry.Length)
