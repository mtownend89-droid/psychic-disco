$ErrorActionPreference='Stop'
$repo='C:\Users\mtown\OneDrive\Documents\GitHub\psychic-disco'
$out=Join-Path $repo 'public\theme-assets\princess'
if(Test-Path $out){ Get-ChildItem $out -File | ForEach-Object { [System.IO.File]::Delete($_.FullName) } } else { New-Item -ItemType Directory -Force -Path $out | Out-Null }
$ci=[System.Globalization.CultureInfo]::InvariantCulture
function N($v){ return [string]::Format($ci,'{0:0.##}',$v) }
$defs="<defs>"+
 "<linearGradient id='sv' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#fff6ea'/><stop offset='.5' stop-color='#eeddc4'/><stop offset='1' stop-color='#cdb79a'/></linearGradient>"+
 "<linearGradient id='sh' x1='0' y1='0' x2='1' y2='0'><stop offset='0' stop-color='#f3e4cf'/><stop offset='.5' stop-color='#fff6ea'/><stop offset='1' stop-color='#e7d4ba'/></linearGradient>"+
 "<linearGradient id='roof' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#9ec8ef'/><stop offset='1' stop-color='#4f7fb8'/></linearGradient>"+
 "<linearGradient id='gv' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#ffe9a8'/><stop offset='.5' stop-color='#e6b23f'/><stop offset='1' stop-color='#a9761c'/></linearGradient>"+
 "<linearGradient id='pv' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#ffd6ec'/><stop offset='.5' stop-color='#ec6fb0'/><stop offset='1' stop-color='#b3437e'/></linearGradient>"+
 "<radialGradient id='pr' cx='.4' cy='.35' r='.75'><stop offset='0' stop-color='#ffe0f1'/><stop offset='.55' stop-color='#ee79b6'/><stop offset='1' stop-color='#b3437e'/></radialGradient>"+
 "<radialGradient id='gem' cx='.38' cy='.32' r='.8'><stop offset='0' stop-color='#ffdcef'/><stop offset='.5' stop-color='#ff4d9e'/><stop offset='1' stop-color='#a01f5e'/></radialGradient></defs>"
$HEART='M12 21 C6 15.5 2.3 12.2 2.3 8.1 C2.3 5.4 4.4 3.5 6.9 3.5 C8.9 3.5 10.8 4.8 12 6.6 C13.2 4.8 15.1 3.5 17.1 3.5 C19.6 3.5 21.7 5.4 21.7 8.1 C21.7 12.2 18 15.5 12 21 Z'
function Heart($cx,$cy,$s,$fill,$stroke){ $k=$s/24; return "<g transform='translate($(N $cx) $(N $cy)) scale($(N $k)) translate(-12 -12.5)'><path d='$HEART' fill='$fill' stroke='$stroke' stroke-width='1.2'/></g>" }
function Gem($cx,$cy,$s){ $k=$s/24; return "<g transform='translate($(N $cx) $(N $cy)) scale($(N $k)) translate(-12 -12)'><path d='M12 2 L21 11 L12 22 L3 11 Z' fill='url(#gem)' stroke='#a01f5e' stroke-width='1'/><path d='M12 2 L12 22 M3 11 L21 11' stroke='#ffdcef' stroke-width='.8' opacity='.7'/></g>" }
# ── CASTLE FRAME (9-slice): turret towers on L/R, battlement walls top & bottom (merlons up), banner flags ──
function Merlons($x0,$x1,$y,$h,$fill){ $s=''; $x=$x0; while($x -lt $x1){ $s+="<rect x='$(N $x)' y='$(N $y)' width='8' height='$(N $h)' fill='$fill' stroke='#b09a78' stroke-width='.6'/>"; $x+=14 }; return $s }
function Banner($cx){ return "<line x1='$(N $cx)' y1='7' x2='$(N $cx)' y2='1' stroke='#8a5a12' stroke-width='1.6'/><circle cx='$(N $cx)' cy='1' r='1.7' fill='#e6b23f'/><path d='M$(N $cx) 2 H$(N ($cx+15)) L$(N ($cx+10)) 6.5 L$(N ($cx+15)) 11 H$(N $cx) Z' fill='url(#pv)' stroke='#b3437e' stroke-width='.7'/><line x1='$(N $cx)' y1='6.5' x2='$(N ($cx+11))' y2='6.5' stroke='#e6b23f' stroke-width='1.1'/>" }
function Tower($cx){
  $t="<rect x='$(N ($cx-18))' y='34' width='36' height='112' fill='url(#sv)' stroke='#b09a78' stroke-width='1'/>"           # body
  $t+="<rect x='$(N ($cx-3))' y='74' width='6' height='22' rx='3' fill='#4a3a52'/>"                                          # arrow slit (mid)
  $t+="<rect x='$(N ($cx-21))' y='132' width='42' height='14' fill='url(#sh)' stroke='#b09a78' stroke-width='1'/>"          # base
  $t+=(Merlons ($cx-17) ($cx+16) 27 9 'url(#sv)')                                                                            # parapet crenellations
  $t+="<path d='M$(N ($cx-16)) 30 L$(N $cx) 6 L$(N ($cx+16)) 30 Z' fill='url(#roof)' stroke='#3f6fa8' stroke-width='1.4' stroke-linejoin='round'/>"  # cone roof
  $t+=(Banner $cx)                                                                                                           # banner flag
  return $t
}
$topWall="<rect x='34' y='27' width='92' height='13' fill='url(#sh)' stroke='#b09a78' stroke-width='1'/>"+(Merlons 38 122 16 11 'url(#sh)')
$botWall="<rect x='34' y='132' width='92' height='12' fill='url(#sh)' stroke='#b09a78' stroke-width='1'/>"+(Merlons 38 122 121 11 'url(#sh)')   # merlons flipped to the top
$frame="<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'>$defs"+$topWall+$botWall+(Tower 27)+(Tower 133)+"</svg>"
# ── controls (same jewelled set as the ornate princess) ──
function Toggle($on){ $kx= if($on){48}else{16}; $fill= if($on){'url(#pv)'}else{'#f4cfe3'}
  return "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='32' viewBox='0 0 64 32' preserveAspectRatio='none'>$defs<rect x='1.5' y='2' width='61' height='28' rx='14' fill='$fill' stroke='url(#gv)' stroke-width='2.5'/>"+(Heart 12 16 8 '#ffffff' 'none')+(Heart 52 16 8 '#ffffff' 'none')+"<circle cx='$kx' cy='16' r='10' fill='url(#gv)' stroke='#8a5a12' stroke-width='1.4'/>"+(Gem $kx 16 8)+"</svg>" }
function Button($fill,$stroke){ return "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='40' viewBox='0 0 100 40' preserveAspectRatio='none'>$defs<rect x='3' y='3' width='94' height='34' rx='16' fill='$fill' stroke='$stroke' stroke-width='2.5'/></svg>" }
$input="<svg xmlns='http://www.w3.org/2000/svg' width='100' height='30' viewBox='0 0 100 30' preserveAspectRatio='none'>$defs<rect x='2' y='2' width='96' height='26' rx='13' fill='#fff6fb' stroke='url(#gv)' stroke-width='2.2'/></svg>"
$cbC="<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>$defs<rect x='3' y='3' width='18' height='18' rx='5' fill='#ffe0f1' stroke='url(#gv)' stroke-width='2.2'/>"+(Heart 12 12 15 'url(#pv)' '#a83a72')+"</svg>"
$thumb="<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>$defs"+(Heart 12 12 22 'url(#pr)' '#a83a72')+"</svg>"
$cbE="<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>$defs<rect x='3' y='3' width='18' height='18' rx='5' fill='#fff6fb' stroke='url(#gv)' stroke-width='2.2'/></svg>"
$badge="<svg xmlns='http://www.w3.org/2000/svg' width='80' height='28' viewBox='0 0 80 28' preserveAspectRatio='none'>$defs<rect x='2' y='2' width='76' height='24' rx='12' fill='url(#pv)' stroke='url(#gv)' stroke-width='1.8'/></svg>"
$panel="<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120' preserveAspectRatio='none'>$defs<rect x='4' y='4' width='112' height='112' rx='14' fill='#fff6fb' stroke='url(#gv)' stroke-width='3.5'/><rect x='11' y='11' width='98' height='98' rx='9' fill='none' stroke='#ff9ecf' stroke-width='1.6'/></svg>"
$files=@{ 'frame.svg'=$frame; 'toggle-off.svg'=(Toggle $false); 'toggle-on.svg'=(Toggle $true); 'button.svg'=(Button '#ffe3f1' 'url(#gv)'); 'button-primary.svg'=(Button 'url(#pv)' 'url(#gv)'); 'button-danger.svg'=(Button '#d84a86' 'url(#gv)'); 'input.svg'=$input; 'checkbox-empty.svg'=$cbE; 'checkbox-checked.svg'=$cbC; 'badge.svg'=$badge; 'panel.svg'=$panel; 'thumb.svg'=$thumb }
foreach($kv in $files.GetEnumerator()){ [System.IO.File]::WriteAllText((Join-Path $out $kv.Key), $kv.Value, (New-Object System.Text.UTF8Encoding($false))) }
# ── wire THEME_SKINS.princess (per-side castle frame; crown emoji over the gatehouse; ambient = THEME_FX royal set) ──
$ub='theme-assets/princess/'
$castle=[char]::ConvertFromUtf32(0x1F3F0)
$entry='THEME_SKINS.princess={frameFront:true,'+
 'frame:{url:"'+$ub+'frame.svg",slice:"40 54 40 54",repeat:"round stretch",width:"28 40 28 40",outset:6},'+
 'topOrnament:{emoji:"'+$castle+'",size:40,top:40},'+
 'controls:{btn:{url:"'+$ub+'button.svg",text:"#5c123f"},btnPrimary:{url:"'+$ub+'button-primary.svg",text:"#fff6fb"},'+
 'btnDanger:{url:"'+$ub+'button-danger.svg",text:"#fff6fb"},toggleOff:{url:"'+$ub+'toggle-off.svg"},toggleOn:{url:"'+$ub+'toggle-on.svg"},'+
 'input:{url:"'+$ub+'input.svg"},checkboxEmpty:{url:"'+$ub+'checkbox-empty.svg"},checkboxChecked:{url:"'+$ub+'checkbox-checked.svg"},'+
 'badge:{url:"'+$ub+'badge.svg",text:"#5c123f"},panel:{url:"'+$ub+'panel.svg"},sliderThumb:{url:"'+$ub+'thumb.svg"}}};'
$tsPath=Join-Path $repo 'public\theme-skins.js'
$t=[System.IO.File]::ReadAllText($tsPath)
$rx=[regex]::new('THEME_SKINS\.princess=\{.*?\};',[System.Text.RegularExpressions.RegexOptions]::Singleline)
$t=$rx.Replace($t,'')
$marker='/*__THEME_SKINS__*/'; $at=$t.IndexOf($marker)+$marker.Length
$t=$t.Substring(0,$at)+"`n"+$entry+$t.Substring($at)
[System.IO.File]::WriteAllText($tsPath,$t,(New-Object System.Text.UTF8Encoding($false)))
Write-Host ("princess (castle): " + $files.Count + " svgs, entry len=" + $entry.Length)
