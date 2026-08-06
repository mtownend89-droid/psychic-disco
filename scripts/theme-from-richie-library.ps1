<#
  theme-from-richie-library.ps1 — ingest an "Ask Richie" 5-file UI library ZIP into a theme.
  See scripts/THEME-SKINS.md for the full guide. To add a theme, edit the 3 lines below
  ($zip, $theme, $tokens), then run this script. It:
    * reads shared <defs> up to the FIRST </defs> (this family closes defs before the symbols),
    * writes each symbol to public/theme-assets/<theme>/*.svg with a luminance-key filter that
      strips the baked black background (these assets are opaque JPEG-on-#000),
    * wires THEME_SKINS.<theme> (pageHeader = top-pipe-header on #topbar, frame = dashboard-frame
      with per-side slice, textless teal/gold/danger buttons, radial-progress slider thumb, etc.),
    * parks the Richie character poses in public/theme-assets/<theme>-richie/ (unwired).
  Then add a THEME_PRESETS + THEME_FX entry in public/app.js (see the doc). If the library's
  buttons carry baked-in labels, repoint btn/btnPrimary/btnDanger to the blank input-field pill
  and add a danger `filter` (see the galaxy/steampunk variants in the doc).
#>
$ErrorActionPreference='Stop'
$zip='C:\Users\mtown\OneDrive\Desktop\Richie\Assets\Themes with Richie\richie-princess-ui-library(3).zip'   # <-- library ZIP
$repo='C:\Users\mtown\OneDrive\Documents\GitHub\psychic-disco'
$theme='princess'                                                                                          # <-- theme id
$tokens=@{text='#FFF0F7';outline='#5c123f'}                                                                # <-- button text / outline (default below)
$outDir=Join-Path $repo ("public\theme-assets\"+$theme)
$richieDir=Join-Path $repo ("assets-parked\"+$theme+"-richie")   # parked OUTSIDE public/ so the heavy unwired poses aren't served/deployed
$tmp=Join-Path $env:TEMP ('sp_'+[guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $zip $tmp -Force
$sym=Get-ChildItem $tmp -Recurse -Filter *-symbols.svg | Select-Object -First 1
$s=[System.IO.File]::ReadAllText($sym.FullName)
$tokens=@{text='#FFF0F7';outline='#5c123f'}
$mapFile=Get-ChildItem $tmp -Recurse -Filter component-map.json | Select-Object -First 1
if($mapFile){ try{ $j=Get-Content $mapFile.FullName -Raw|ConvertFrom-Json; if($j.tokens){ if($j.tokens.text){$tokens.text=$j.tokens.text}; if($j.tokens.outline){$tokens.outline=$j.tokens.outline} } }catch{} }
# shared defs = content between <defs> and the FIRST </defs> (this library closes defs long before the symbols)
$defsOpen=$s.IndexOf('<defs>'); $defsClose=$s.IndexOf('</defs>'); $firstSym=$s.IndexOf('<symbol')
$end= if($defsClose -ge 0){ $defsClose } else { $firstSym }
$shared= if($defsOpen -ge 0 -and $end -gt $defsOpen){$s.Substring($defsOpen+6,$end-($defsOpen+6))}else{''}
Write-Host ("shared defs KB=" + [math]::Round($shared.Length/1KB,2))
foreach($d in @($outDir,$richieDir)){ if(Test-Path $d){ Get-ChildItem $d -File | ForEach-Object { [System.IO.File]::Delete($_.FullName) } } else { New-Item -ItemType Directory -Force -Path $d | Out-Null } }
# Each asset is an opaque JPEG of the object on a near-black backing (plus a solid "Base Metal" #050505 rect and an
# undefined-class hit-area rect). This luminance key turns near-black pixels transparent so only the object remains:
# alpha = weighted luma; feFunc discrete zeroes anything below ~0.10 luma; composite keeps the source where the mask is opaque.
$keyFilter="<filter id='dropblk' color-interpolation-filters='sRGB'><feColorMatrix type='matrix' values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.6 0.75 0.5 0 0' result='l'/><feComponentTransfer in='l' result='m'><feFuncA type='discrete' tableValues='0 1 1 1 1 1 1 1 1 1'/></feComponentTransfer><feComposite in='SourceGraphic' in2='m' operator='in'/></filter>"
function WriteSym([string]$id,[string]$file,[string]$dir,[string]$urlBase,[string]$preserve=''){
  $ss=$s.IndexOf('<symbol id="'+$id+'"'); if($ss -lt 0){ Write-Host "  MISSING $id"; return $null }
  $vbS=$s.IndexOf('viewBox="',$ss)+9; $vbE=$s.IndexOf('"',$vbS); $vb=$s.Substring($vbS,$vbE-$vbS)
  $cs=$s.IndexOf('>',$ss)+1; $ce=$s.IndexOf('</symbol>',$cs); $inner=$s.Substring($cs,$ce-$cs)
  $par= if($preserve){ " preserveAspectRatio='$preserve'" } else { '' }
  $svg="<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' xmlns:inkscape='http://www.inkscape.org/namespaces/inkscape' xmlns:sodipodi='http://sodipodi.sourceforge.net/DTD/sodipodi-0.0.dtd' viewBox='$vb'$par><defs>$shared$keyFilter</defs><g filter='url(#dropblk)'>$inner</g></svg>"
  [System.IO.File]::WriteAllText((Join-Path $dir $file),$svg,(New-Object System.Text.UTF8Encoding($false)))
  return $urlBase+$file
}
$ub='theme-assets/'+$theme+'/'
function Fname([string]$symId){ return ($symId -replace '^symbol-','')+'.svg' }
# ── controls (steampunk buttons are textless vector art, so the real teal/gold/danger buttons are used) ──
$map=[ordered]@{ btn='symbol-button-teal'; btnPrimary='symbol-button-gold'; btnDanger='symbol-button-danger'; toggleOff='symbol-toggle-secondary'; toggleOn='symbol-toggle-primary'; input='symbol-input-field'; checkboxEmpty='symbol-checkbox-empty'; checkboxChecked='symbol-checkbox-checked'; badge='symbol-icon-check'; panel='symbol-modal-window'; chatRichie='symbol-chat-bubble'; sliderThumb='symbol-radial-progress' }
$ctl=[ordered]@{}
foreach($role in $map.Keys){ $u=WriteSym $map[$role] (Fname $map[$role]) $outDir $ub; if($u){ $ctl[$role]=$u } }
# top pipe header → the app's very top page header bar (stretched full-width)
$ph=WriteSym 'symbol-top-pipe-header' (Fname 'symbol-top-pipe-header') $outDir $ub 'none'; if($ph){ $ctl['pageHeader']=$ph }
# royal dashboard frame → wraps every widget (written keyed; slices decided after measuring the ornament bands)
[void](WriteSym 'symbol-dashboard-frame' (Fname 'symbol-dashboard-frame') $outDir $ub)
# ── ambient FX art (gears, vials, gadgets) ──
$emojiSyms='symbol-gear-cluster','symbol-energy-vial','symbol-vault','symbol-treasure-chest','symbol-boiler-device','symbol-lamp-dome','symbol-telescope'
$emo=@(); foreach($e in $emojiSyms){ $u=WriteSym $e (Fname $e) $outDir $ub; if($u){ $emo+=$u } }
# ── Richie poses → separate folder, unwired ──
foreach($r in 'symbol-hero-richie','symbol-richie-scepter','symbol-richie-clock','symbol-richie-wrench','symbol-richie-boiler','symbol-richie-thumbs','symbol-richie-bulb'){ [void](WriteSym $r (Fname $r) $richieDir ('theme-assets/'+$theme+'-richie/')) }
# ── assemble THEME_SKINS.steampunk entry ──
$parts=@()
# modal-window wraps every widget as a 9-slice frame. modal-window is 315x280; slice 73 (<half of 280) keeps a middle
# band on every side so the frame wraps the WHOLE widget (bigger slices collapse the edges).
# Royal Dashboard Frame (595x275) wraps every widget. Per-side 9-slice (top right bottom left): the tall top ornament
# (dense through ~30% = ~85px) and the bottom rail (~45px) are sliced separately from the thin ~28px side drapes, so the
# sides don't stretch into fat blurry columns and the top doesn't squash. border-width matches so proportions hold.
$parts+='frame:{url:"'+$ub+'dashboard-frame.svg",slice:"85 30 46 30",repeat:"stretch",width:"60 22 34 22",outset:0}'
$parts+='titleInFrame:24'
$cparts=@()
foreach($role in $ctl.Keys){
  $extra=''
  if($role -eq 'btn' -or $role -eq 'btnDanger' -or $role -eq 'chatRichie'){ $extra=',text:"'+$tokens.text+'"' }
  elseif($role -eq 'btnPrimary'){ $extra=',text:"'+$tokens.outline+'"' }
  $cparts+=$role+':{url:"'+$ctl[$role]+'"'+$extra+'}'
}
if($cparts.Count){ $parts+='controls:{'+($cparts -join ',')+'}' }
if($emo.Count){ $parts+='emoji:['+(($emo|ForEach-Object{'"'+$_+'"'}) -join ',')+']' }
$entry='THEME_SKINS.'+$theme+'={'+($parts -join ',')+'};'
$tsPath=Join-Path $repo 'public\theme-skins.js'
$t=[System.IO.File]::ReadAllText($tsPath)
$rx=[regex]::new('THEME_SKINS\.'+$theme+'=\{.*?\};',[System.Text.RegularExpressions.RegexOptions]::Singleline)
$t=$rx.Replace($t,'')
$marker='/*__THEME_SKINS__*/'; $at=$t.IndexOf($marker)+$marker.Length
$t=$t.Substring(0,$at)+"`n"+$entry+$t.Substring($at)
[System.IO.File]::WriteAllText($tsPath,$t,(New-Object System.Text.UTF8Encoding($false)))
Write-Host ("entry len=" + $entry.Length + "  theme-skins.js KB=" + [math]::Round((Get-Item $tsPath).Length/1KB,1))
Write-Host "steampunk/ files:"; Get-ChildItem $outDir -File | Select-Object Name,@{n='KB';e={[math]::Round($_.Length/1KB,1)}} | Sort-Object KB -Descending | Format-Table -AutoSize
