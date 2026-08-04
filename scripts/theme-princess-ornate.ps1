$ErrorActionPreference='Stop'
$repo='C:\Users\mtown\OneDrive\Documents\GitHub\psychic-disco'
$out=Join-Path $repo 'public\theme-assets\princess'
if(Test-Path $out){ Get-ChildItem $out -File | ForEach-Object { [System.IO.File]::Delete($_.FullName) } } else { New-Item -ItemType Directory -Force -Path $out | Out-Null }
$ci=[System.Globalization.CultureInfo]::InvariantCulture
function N($v){ return [string]::Format($ci,'{0:0.##}',$v) }
$defs="<defs>"+
 "<linearGradient id='gv' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#ffe9a8'/><stop offset='.45' stop-color='#e6b23f'/><stop offset='1' stop-color='#a9761c'/></linearGradient>"+
 "<linearGradient id='gh' x1='0' y1='0' x2='1' y2='0'><stop offset='0' stop-color='#ffe9a8'/><stop offset='.5' stop-color='#e6b23f'/><stop offset='1' stop-color='#a9761c'/></linearGradient>"+
 "<linearGradient id='pv' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#ffd6ec'/><stop offset='.5' stop-color='#ec6fb0'/><stop offset='1' stop-color='#b3437e'/></linearGradient>"+
 "<linearGradient id='ph' x1='0' y1='0' x2='1' y2='0'><stop offset='0' stop-color='#ffd6ec'/><stop offset='.5' stop-color='#ec6fb0'/><stop offset='1' stop-color='#b3437e'/></linearGradient>"+
 "<radialGradient id='pr' cx='.4' cy='.35' r='.75'><stop offset='0' stop-color='#ffe0f1'/><stop offset='.55' stop-color='#ee79b6'/><stop offset='1' stop-color='#b3437e'/></radialGradient>"+
 "<radialGradient id='gem' cx='.38' cy='.32' r='.8'><stop offset='0' stop-color='#ffdcef'/><stop offset='.5' stop-color='#ff4d9e'/><stop offset='1' stop-color='#a01f5e'/></radialGradient></defs>"
function Pearl($x,$y,$r){ return "<circle cx='$(N $x)' cy='$(N $y)' r='$(N $r)' fill='url(#gv)' stroke='#8a5a12' stroke-width='.6'/><circle cx='$(N $x)' cy='$(N ($y-$r*0.32))' r='$(N ($r*0.34))' fill='#fff6e0'/>" }
function Gem($cx,$cy,$s){ $k=$s/24; return "<g transform='translate($(N $cx) $(N $cy)) scale($(N $k)) translate(-12 -12)'><path d='M12 2 L21 11 L12 22 L3 11 Z' fill='url(#gem)' stroke='#a01f5e' stroke-width='1'/><path d='M12 2 L12 22 M3 11 L21 11' stroke='#ffdcef' stroke-width='.8' opacity='.7'/></g>" }
$HEART='M12 21 C6 15.5 2.3 12.2 2.3 8.1 C2.3 5.4 4.4 3.5 6.9 3.5 C8.9 3.5 10.8 4.8 12 6.6 C13.2 4.8 15.1 3.5 17.1 3.5 C19.6 3.5 21.7 5.4 21.7 8.1 C21.7 12.2 18 15.5 12 21 Z'
function Heart($cx,$cy,$s,$fill,$stroke){ $k=$s/24; return "<g transform='translate($(N $cx) $(N $cy)) scale($(N $k)) translate(-12 -12.5)'><path d='$HEART' fill='$fill' stroke='$stroke' stroke-width='1.2'/></g>" }
function Rose($cx,$cy,$r){ $p=''; for($k=0;$k -lt 5;$k++){ $a=$k*2*[math]::PI/5 - [math]::PI/2; $px=$cx+$r*0.5*[math]::Cos($a); $py=$cy+$r*0.5*[math]::Sin($a); $p+="<circle cx='$(N $px)' cy='$(N $py)' r='$(N ($r*0.44))' fill='url(#pr)' stroke='#a83a72' stroke-width='.6'/>" }; $p+="<circle cx='$(N $cx)' cy='$(N $cy)' r='$(N ($r*0.4))' fill='url(#gv)' stroke='#8a5a12' stroke-width='.6'/>"; return $p }
# ── FRAME: gold ornate band (9-slice) + a royal EMOJI at each corner (TL,TR,BL,BR) ──
$corners=@(@(30,30),@(130,30),@(30,130),@(130,130))
$cornerEmoji=@([char]::ConvertFromUtf32(0x1F380),[char]::ConvertFromUtf32(0x1F48E),[char]::ConvertFromUtf32(0x269C)+[char]0xFE0F,[char]::ConvertFromUtf32(0x1F339))  # ribbon, gem, fleur-de-lis, rose
$orn=''; for($i=0;$i -lt 4;$i++){ $c=$corners[$i]; $orn+="<text x='$($c[0])' y='$($c[1]+13)' font-size='36' text-anchor='middle'>$($cornerEmoji[$i])</text>" }
$frame="<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'>$defs"+
 "<rect x='27' y='27' width='106' height='106' rx='22' fill='none' stroke='#9c3f74' stroke-width='22'/>"+
 "<rect x='27' y='27' width='106' height='106' rx='22' fill='none' stroke='url(#gv)' stroke-width='14'/>"+
 "<rect x='27' y='27' width='106' height='106' rx='22' fill='none' stroke='#fff2c0' stroke-width='2' opacity='.5'/>"+
 "<rect x='38' y='38' width='84' height='84' rx='14' fill='none' stroke='#ff9ecf' stroke-width='2.4' opacity='.8'/>"+
 $orn+"</svg>"
# ── CROWN (top-centre ornament) ──
$cg=''; foreach($t in @(14,32,50)){ $cg+= (Gem $t 11 8) }
$cb=''; foreach($x in @(18,32,46)){ $cb+= (Pearl $x 35 2.4) }
$crown="<svg xmlns='http://www.w3.org/2000/svg' width='64' height='46' viewBox='0 0 64 46'>$defs"+
 "<path d='M8 34 L13 12 L23 27 L32 7 L41 27 L51 12 L56 34 Z' fill='url(#gv)' stroke='#8a5a12' stroke-width='1.6' stroke-linejoin='round'/>"+
 "<rect x='9' y='31' width='46' height='9' rx='3' fill='url(#gh)' stroke='#8a5a12' stroke-width='1.2'/>"+
 $cg+$cb+"</svg>"
# ── TOGGLE: pink jewelled pill ──
function Toggle($on){ $kx= if($on){48}else{16}; $fill= if($on){'url(#ph)'}else{'#f4cfe3'}
  return "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='32' viewBox='0 0 64 32' preserveAspectRatio='none'>$defs"+
   "<rect x='1.5' y='2' width='61' height='28' rx='14' fill='$fill' stroke='url(#gh)' stroke-width='2.5'/>"+
   (Heart 12 16 8 '#ffffff' 'none')+(Heart 52 16 8 '#ffffff' 'none')+
   "<circle cx='$kx' cy='16' r='10' fill='url(#gv)' stroke='#8a5a12' stroke-width='1.4'/>"+(Gem $kx 16 8)+"</svg>" }
# ── BUTTONS: rounded, gold border + gem + corner pearls ──
function Button($fill,$stroke){ return "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='40' viewBox='0 0 100 40' preserveAspectRatio='none'>$defs<rect x='3' y='3' width='94' height='34' rx='16' fill='$fill' stroke='$stroke' stroke-width='2.5'/>"+(Pearl 11 9 2)+(Pearl 89 9 2)+(Pearl 11 31 2)+(Pearl 89 31 2)+"</svg>" }
$input="<svg xmlns='http://www.w3.org/2000/svg' width='100' height='30' viewBox='0 0 100 30' preserveAspectRatio='none'>$defs<rect x='2' y='2' width='96' height='26' rx='13' fill='#fff6fb' stroke='url(#gh)' stroke-width='2.2'/>"+(Pearl 9 6 1.8)+(Pearl 91 6 1.8)+"</svg>"
$cbE="<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>$defs<rect x='3' y='3' width='18' height='18' rx='5' fill='#fff6fb' stroke='url(#gv)' stroke-width='2.2'/></svg>"
$cbC="<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>$defs<rect x='3' y='3' width='18' height='18' rx='5' fill='#ffe0f1' stroke='url(#gv)' stroke-width='2.2'/>"+(Heart 12 12 15 'url(#ph)' '#a83a72')+"</svg>"
$badge="<svg xmlns='http://www.w3.org/2000/svg' width='80' height='28' viewBox='0 0 80 28' preserveAspectRatio='none'>$defs<rect x='2' y='2' width='76' height='24' rx='12' fill='url(#ph)' stroke='url(#gh)' stroke-width='1.8'/></svg>"
$panel="<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120' preserveAspectRatio='none'>$defs<rect x='4' y='4' width='112' height='112' rx='14' fill='#fff6fb' stroke='url(#gv)' stroke-width='3.5'/><rect x='11' y='11' width='98' height='98' rx='9' fill='none' stroke='#ff9ecf' stroke-width='1.6'/></svg>"
$thumb="<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>$defs"+(Heart 12 12 22 'url(#pr)' '#a83a72')+"</svg>"
$files=@{ 'frame.svg'=$frame; 'toggle-off.svg'=(Toggle $false); 'toggle-on.svg'=(Toggle $true);
 'button.svg'=(Button '#ffe3f1' 'url(#gv)'); 'button-primary.svg'=(Button 'url(#pv)' 'url(#gv)'); 'button-danger.svg'=(Button '#d84a86' 'url(#gv)');
 'input.svg'=$input; 'checkbox-empty.svg'=$cbE; 'checkbox-checked.svg'=$cbC; 'badge.svg'=$badge; 'panel.svg'=$panel; 'thumb.svg'=$thumb }
foreach($k in $files.Keys){ [System.IO.File]::WriteAllText((Join-Path $out $k), $files[$k], (New-Object System.Text.UTF8Encoding($false))) }
# ── wire THEME_SKINS.princess (topOrnament is the castle emoji; ambient falls back to THEME_FX royal emojis) ──
$ub='theme-assets/princess/'
$castle=[char]::ConvertFromUtf32(0x1F3F0)
$entry='THEME_SKINS.princess={frameFront:true,centerTitle:true,frame:{url:"'+$ub+'frame.svg",slice:48,repeat:"stretch",width:30,outset:6},'+
 'topOrnament:{emoji:"'+$castle+'",size:46,top:34},'+
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
Write-Host ("princess: " + $files.Count + " svgs, entry len=" + $entry.Length)
