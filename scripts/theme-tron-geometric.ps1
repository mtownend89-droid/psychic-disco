$ErrorActionPreference='Stop'
$repo='C:\Users\mtown\OneDrive\Documents\GitHub\psychic-disco'
$out=Join-Path $repo 'public\theme-assets\tron'
if(-not (Test-Path $out)){ New-Item -ItemType Directory -Force -Path $out | Out-Null }
function W($name,$svg){ [System.IO.File]::WriteAllText((Join-Path $out $name), $svg, (New-Object System.Text.UTF8Encoding($false))) }
# palette: cyan #34e7ff, bright #9df4ff, knob #5ffcff, dark casing #06121c, fills #0a1826 / #0e3a4a, red #ff4d6a
# ── widget frame: octagon HUD (9-sliced), deep sharp corner cuts, thick cyan line + magenta corner accents + edge ticks ──
W 'frame.svg' '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120" fill="none"><path d="M4 46 V20 L20 4 H100 L116 20 V100 L100 116 H20 L4 100 Z" stroke="#06121c" stroke-width="8"/><path d="M4 46 V20 L20 4 H100 L116 20 V100 L100 116 H20 L4 100 Z" stroke="#34e7ff" stroke-width="3"/><path d="M9 21 L21 9 M99 9 L111 21 M111 99 L99 111 M21 111 L9 99" stroke="#ff4dd8" stroke-width="1.8"/><g stroke="#34e7ff" stroke-width="2"><path d="M31 4 V12 M89 4 V12 M31 116 V108 M89 116 V108 M4 31 H12 M4 89 H12 M116 31 H108 M116 89 H108"/></g></svg>'
# ── filled panel for pop-out modals (matching sharp corners + magenta accents) ──
W 'panel.svg' '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" preserveAspectRatio="none" fill="none"><path d="M4 30 V16 L16 4 H104 L116 16 V104 L104 116 H16 L4 104 Z" fill="#07121c" stroke="#34e7ff" stroke-width="2.4"/><path d="M9 18 L18 9 M102 9 L111 18 M111 102 L102 111 M18 111 L9 102" stroke="#ff4dd8" stroke-width="1.6"/></svg>'
# ── buttons (angular, cut corners) ──
W 'button.svg'         '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40" preserveAspectRatio="none" fill="none"><path d="M3 20 V9 L11 3 H89 L97 9 V31 L89 37 H11 L3 31 Z" fill="#0a1826" stroke="#34e7ff" stroke-width="2"/></svg>'
W 'button-primary.svg' '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40" preserveAspectRatio="none" fill="none"><path d="M3 20 V9 L11 3 H89 L97 9 V31 L89 37 H11 L3 31 Z" fill="#5f1450" stroke="#ff6ee0" stroke-width="2"/></svg>'
W 'button-danger.svg'  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40" preserveAspectRatio="none" fill="none"><path d="M3 20 V9 L11 3 H89 L97 9 V31 L89 37 H11 L3 31 Z" fill="#1a0d12" stroke="#ff4d6a" stroke-width="2"/></svg>'
# ── toggles (rectangular cyber knob) ──
W 'toggle-off.svg' '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32" preserveAspectRatio="none" fill="none"><rect x="2" y="4" width="60" height="24" rx="3" fill="#0a1826" stroke="#2a6577" stroke-width="2"/><rect x="7" y="9" width="16" height="14" rx="2" fill="#4a7688"/></svg>'
W 'toggle-on.svg'  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32" preserveAspectRatio="none" fill="none"><rect x="2" y="4" width="60" height="24" rx="3" fill="#3a0d30" stroke="#ff4dd8" stroke-width="2"/><rect x="41" y="9" width="16" height="14" rx="2" fill="#ff8fe8"/></svg>'
# ── input bar ──
W 'input.svg' '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 30" preserveAspectRatio="none" fill="none"><path d="M2 15 V6 L7 2 H98 V24 L93 28 H2 Z" fill="#07121c" stroke="#2a6577" stroke-width="1.6"/></svg>'
# ── checkbox ──
W 'checkbox-empty.svg'   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M4 4 H20 V20 H4 Z" fill="#0a1826" stroke="#2a6577" stroke-width="2"/></svg>'
W 'checkbox-checked.svg' '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M4 4 H20 V20 H4 Z" fill="#0e3a4a" stroke="#34e7ff" stroke-width="2"/><path d="M7 12 L11 16 L18 7" stroke="#5ffcff" stroke-width="2.4"/></svg>'
# ── badge chip ──
W 'badge.svg' '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 28" preserveAspectRatio="none" fill="none"><path d="M2 14 V6 L7 2 H73 L78 6 V22 L73 26 H7 L2 22 Z" fill="#0e3a4a" stroke="#34e7ff" stroke-width="1.5"/></svg>'
# ── slider thumb (diamond) ──
W 'thumb.svg' '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M12 2 L22 12 L12 22 L2 12 Z" fill="#0a1826" stroke="#34e7ff" stroke-width="2"/><circle cx="12" cy="12" r="2.6" fill="#5ffcff"/></svg>'
# ── ambient geometrics ──
W 'fx-diamond.svg' '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none"><path d="M10 1 L19 10 L10 19 L1 10 Z" stroke="#34e7ff" stroke-width="1.6"/></svg>'
W 'fx-tri.svg'     '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none"><path d="M10 2 L18 17 H2 Z" stroke="#34e7ff" stroke-width="1.6"/></svg>'
W 'fx-chev.svg'    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none"><path d="M4 5 L10 10 L4 15 M10 5 L16 10 L10 15" stroke="#34e7ff" stroke-width="1.6"/></svg>'
W 'fx-hex.svg'     '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none"><path d="M10 2 L17 6.5 V13.5 L10 18 L3 13.5 V6.5 Z" stroke="#ff4dd8" stroke-width="1.6"/></svg>'
# ── assemble THEME_SKINS.tron entry ──
$ub='theme-assets/tron/'
$entry='THEME_SKINS.tron={frameFront:true,titleBar:true,dividers:true,frame:{url:"'+$ub+'frame.svg",slice:34,repeat:"stretch",width:20,outset:8,glow:6,glowColor:"#34e7ff"},'+
 'controls:{btn:{url:"'+$ub+'button.svg",text:"#cbf5ff"},btnPrimary:{url:"'+$ub+'button-primary.svg",text:"#ffeaff"},'+
 'btnDanger:{url:"'+$ub+'button-danger.svg",text:"#ffd9e0"},toggleOff:{url:"'+$ub+'toggle-off.svg"},toggleOn:{url:"'+$ub+'toggle-on.svg"},'+
 'input:{url:"'+$ub+'input.svg"},checkboxEmpty:{url:"'+$ub+'checkbox-empty.svg"},checkboxChecked:{url:"'+$ub+'checkbox-checked.svg"},'+
 'badge:{url:"'+$ub+'badge.svg",text:"#cbf5ff"},panel:{url:"'+$ub+'panel.svg"},sliderThumb:{url:"'+$ub+'thumb.svg"}},'+
 'emoji:["'+$ub+'fx-diamond.svg","'+$ub+'fx-tri.svg","'+$ub+'fx-chev.svg","'+$ub+'fx-hex.svg"]};'
$tsPath=Join-Path $repo 'public\theme-skins.js'
$t=[System.IO.File]::ReadAllText($tsPath)
$rx=[regex]::new('THEME_SKINS\.tron=\{.*?\};',[System.Text.RegularExpressions.RegexOptions]::Singleline)
$t=$rx.Replace($t,'')
$marker='/*__THEME_SKINS__*/'; $at=$t.IndexOf($marker)+$marker.Length
$t=$t.Substring(0,$at)+"`n"+$entry+$t.Substring($at)
[System.IO.File]::WriteAllText($tsPath,$t,(New-Object System.Text.UTF8Encoding($false)))
Write-Host ("tron entry len=" + $entry.Length + "  files=" + (Get-ChildItem $out -File).Count)
