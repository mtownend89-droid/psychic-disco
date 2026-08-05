<#
  theme-ocean.ps1 — Ocean theme: library wave on the top bar + library end-curls in the bottom corners,
  hand-authored upward-animating bubble side frames + bubble toggles + glassy aqua controls.
  Uses the reusable `edges` skin hook (top/cornerL/cornerR/cornerA on ::before, animated `side` on ::after).
  See scripts/THEME-SKINS.md. Requires the ocean-wave library ZIP for the wave + curls.
#>
$ErrorActionPreference='Stop'
$repo='C:\Users\mtown\OneDrive\Documents\GitHub\psychic-disco'
$zip='C:\Users\mtown\OneDrive\Desktop\Richie\Assets\richie-ocean-wave-ui-library.zip'
$out=Join-Path $repo 'public\theme-assets\ocean'
if(Test-Path $out){ Get-ChildItem $out -File | ForEach-Object { [System.IO.File]::Delete($_.FullName) } } else { New-Item -ItemType Directory -Force -Path $out | Out-Null }
$ci=[System.Globalization.CultureInfo]::InvariantCulture
function N($v){ return [string]::Format($ci,'{0:0.##}',$v) }
# ── extract library wave + curls (PNG-on-transparent; keep the <style> so hit-area stays clear) ──
$tmp=Join-Path $env:TEMP ('oc_'+[guid]::NewGuid().ToString('N')); Expand-Archive -LiteralPath $zip $tmp -Force
$symFile=Get-ChildItem $tmp -Recurse -Filter *-symbols.svg | Select-Object -First 1
$s=[System.IO.File]::ReadAllText($symFile.FullName)
$defsOpen=$s.IndexOf('<defs>'); $defsClose=$s.IndexOf('</defs>'); $shared=$s.Substring($defsOpen+6,$defsClose-($defsOpen+6))
function Lib([string]$id,[bool]$stretch){
  $ss=$s.IndexOf('<symbol id="'+$id+'"'); if($ss -lt 0){ Write-Host "MISSING $id"; return }
  $vbS=$s.IndexOf('viewBox="',$ss)+9; $vbE=$s.IndexOf('"',$vbS); $vb=$s.Substring($vbS,$vbE-$vbS)
  $cs=$s.IndexOf('>',$ss)+1; $ce=$s.IndexOf('</symbol>',$cs); $inner=$s.Substring($cs,$ce-$cs)
  $par= if($stretch){ " preserveAspectRatio='none'" } else { '' }  # none only for the stretched top wave; curls keep aspect
  # xmlns:inkscape/sodipodi MUST be declared or the library's inkscape:* attrs make the SVG not well-formed -> won't render
  $svg="<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' xmlns:inkscape='http://www.inkscape.org/namespaces/inkscape' xmlns:sodipodi='http://sodipodi.sourceforge.net/DTD/sodipodi-0.0.dtd' viewBox='$vb'$par><defs>$shared</defs>$inner</svg>"
  [System.IO.File]::WriteAllText((Join-Path $out ($id+'.svg')), $svg, (New-Object System.Text.UTF8Encoding($false)))
}
Lib 'assembled-bottom-edge' $true   # top wave only (corner curls removed)
# ── hand-authored controls (aqua glass + bubbles) ──
$defs="<defs>"+
 "<linearGradient id='av' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#8ff3ff'/><stop offset='.5' stop-color='#31c2dd'/><stop offset='1' stop-color='#127390'/></linearGradient>"+
 "<radialGradient id='bub' cx='.36' cy='.32' r='.7'><stop offset='0' stop-color='#f2ffff'/><stop offset='.4' stop-color='#9fecff' stop-opacity='.5'/><stop offset='1' stop-color='#2fbfd8' stop-opacity='.25'/></radialGradient>"+
 "<linearGradient id='glass' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#7fe6ff' stop-opacity='.35'/><stop offset='1' stop-color='#1b7a94' stop-opacity='.35'/></linearGradient></defs>"
function Bubble($cx,$cy,$r){ return "<circle cx='$(N $cx)' cy='$(N $cy)' r='$(N $r)' fill='url(#bub)' stroke='#bff3ff' stroke-width='1'/><circle cx='$(N ($cx-$r*0.32))' cy='$(N ($cy-$r*0.32))' r='$(N ($r*0.26))' fill='#f2ffff' opacity='.85'/>" }
function Side(){ $bb=@(@(13,14,5),@(19,37,3.2),@(9,58,4.6),@(21,52,2.3)); $x="<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 26 72'>$defs"; foreach($b in $bb){ $x+=(Bubble $b[0] $b[1] $b[2]) }; return $x+"</svg>" }
function Toggle($on){ $kx= if($on){48}else{16}; $pf= if($on){'#3fcfe8'}else{'#2a6b80'}; $ex= if($on){(Bubble 40 9 2.2)+(Bubble 44 22 1.8)}else{''}
  return "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='32' viewBox='0 0 64 32' preserveAspectRatio='none'>$defs<rect x='2' y='4' width='60' height='24' rx='12' fill='$pf' fill-opacity='.28' stroke='#5fd8ee' stroke-width='2'/>$ex"+(Bubble $kx 16 9)+"</svg>" }
function Button($fill,$stroke){ return "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='40' viewBox='0 0 100 40' preserveAspectRatio='none'>$defs<rect x='3' y='3' width='94' height='34' rx='17' fill='$fill' stroke='$stroke' stroke-width='2'/><ellipse cx='50' cy='11' rx='44' ry='6' fill='#eafcff' opacity='.22'/></svg>" }
$input="<svg xmlns='http://www.w3.org/2000/svg' width='100' height='30' viewBox='0 0 100 30' preserveAspectRatio='none'>$defs<rect x='2' y='2' width='96' height='26' rx='13' fill='#0e3a4f' stroke='#3fb6d0' stroke-width='2'/></svg>"
$cbE="<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>$defs<rect x='3' y='3' width='18' height='18' rx='7' fill='#0e3a4f' stroke='#3fb6d0' stroke-width='2'/></svg>"
$cbC="<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>$defs<rect x='3' y='3' width='18' height='18' rx='7' fill='#134f66' stroke='#5fd8ee' stroke-width='2'/><path d='M7 12 L11 16 L18 7' fill='none' stroke='#eafcff' stroke-width='2.4'/></svg>"
$badge="<svg xmlns='http://www.w3.org/2000/svg' width='80' height='28' viewBox='0 0 80 28' preserveAspectRatio='none'>$defs<rect x='2' y='2' width='76' height='24' rx='12' fill='url(#glass)' stroke='#5fd8ee' stroke-width='1.6'/></svg>"
$panel="<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120' preserveAspectRatio='none'>$defs<rect x='4' y='4' width='112' height='112' rx='14' fill='#0e3040' stroke='#3fb6d0' stroke-width='3'/></svg>"
$thumb="<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>$defs"+(Bubble 12 12 10)+"</svg>"
function FxBub($cluster){ $x="<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>$defs"; if($cluster){ $x+=(Bubble 9 14 6)+(Bubble 17 8 4)+(Bubble 16 18 3) } else { $x+=(Bubble 12 12 10) }; return $x+"</svg>" }
$files=@{ 'side.svg'=(Side); 'toggle-off.svg'=(Toggle $false); 'toggle-on.svg'=(Toggle $true); 'button.svg'=(Button 'url(#glass)' '#5fd8ee'); 'button-primary.svg'=(Button '#2fbfd8' '#bff3ff'); 'button-danger.svg'=(Button '#c65a6a' '#ffd0d8'); 'input.svg'=$input; 'checkbox-empty.svg'=$cbE; 'checkbox-checked.svg'=$cbC; 'badge.svg'=$badge; 'panel.svg'=$panel; 'thumb.svg'=$thumb; 'fx-bubble-a.svg'=(FxBub $false); 'fx-bubble-b.svg'=(FxBub $true); 'fx-bubble-c.svg'=("<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>$defs"+(Bubble 12 12 8)+"</svg>") }
foreach($k in $files.Keys){ [System.IO.File]::WriteAllText((Join-Path $out $k), $files[$k], (New-Object System.Text.UTF8Encoding($false))) }
# ── entry ──
$ub='theme-assets/ocean/'
$entry='THEME_SKINS.ocean={'+
 'edges:{top:{url:"'+$ub+'assembled-bottom-edge.svg",h:52,over:28},side:{url:"'+$ub+'side.svg",w:26,tile:72,dur:5},pad:"14px 22px 18px"},'+
 'controls:{btn:{url:"'+$ub+'button.svg",text:"#eafcff"},btnPrimary:{url:"'+$ub+'button-primary.svg",text:"#06303c"},btnDanger:{url:"'+$ub+'button-danger.svg",text:"#fff0f2"},toggleOff:{url:"'+$ub+'toggle-off.svg"},toggleOn:{url:"'+$ub+'toggle-on.svg"},input:{url:"'+$ub+'input.svg"},checkboxEmpty:{url:"'+$ub+'checkbox-empty.svg"},checkboxChecked:{url:"'+$ub+'checkbox-checked.svg"},badge:{url:"'+$ub+'badge.svg",text:"#06303c"},panel:{url:"'+$ub+'panel.svg"},sliderThumb:{url:"'+$ub+'thumb.svg"}},'+
 'emoji:["'+$ub+'fx-bubble-a.svg","'+$ub+'fx-bubble-b.svg","'+$ub+'fx-bubble-c.svg"]};'
$tsPath=Join-Path $repo 'public\theme-skins.js'
$t=[System.IO.File]::ReadAllText($tsPath)
$rx=[regex]::new('THEME_SKINS\.ocean=\{.*?\};',[System.Text.RegularExpressions.RegexOptions]::Singleline)
$t=$rx.Replace($t,'')
$marker='/*__THEME_SKINS__*/'; $at=$t.IndexOf($marker)+$marker.Length
$t=$t.Substring(0,$at)+"`n"+$entry+$t.Substring($at)
[System.IO.File]::WriteAllText($tsPath,$t,(New-Object System.Text.UTF8Encoding($false)))
Write-Host ("ocean: entry len=" + $entry.Length + "  files=" + (Get-ChildItem $out -File).Count)
