<#
  build-theme-skin.ps1  —  wire a theme UI-asset ZIP into the app (plug-and-play).

  A theme "library" ZIP must contain (same shape as ask-richie-slime-ui-library.zip):
    *-symbols.svg      an SVG whose <defs> holds shared gradients/filters/primitives
                       followed by <symbol id="..."> components.
    component-map.json (optional) with a "tokens" object (text/outline colors).

  Standard symbol ids it looks for (missing ones are skipped):
    slime-frame, button-secondary, button-primary, button-danger, toggle-off, toggle-on,
    input-field, checkbox-empty, checkbox-checked, radio-selected, tab-inactive, tab-active,
    badge, slime-panel

  Each symbol is turned into a self-contained data-URI SVG (its inner markup + the library's
  shared <defs>) and written into public/app.js as:  THEME_SKINS.<themeId> = { ... };
  at the /*__THEME_SKINS__*/ marker (replacing any existing entry for that id).
  _applyThemeSkin() in the app then generates + injects the scoped CSS automatically.

  Usage:
    pwsh scripts/build-theme-skin.ps1 -Zip "C:\path\my-theme.zip" -ThemeId slime
#>
param(
  [Parameter(Mandatory=$true)][string]$Zip,
  [Parameter(Mandatory=$true)][string]$ThemeId,
  [string]$App = (Join-Path $PSScriptRoot '..\public\theme-skins.js')
)
$ErrorActionPreference='Stop'
$tmp = Join-Path $env:TEMP ('themeskin_'+[guid]::NewGuid().ToString('N'))
Expand-Archive -Path $Zip -DestinationPath $tmp -Force
try {
  $symSvg = Get-ChildItem $tmp -Recurse -Filter *-symbols.svg | Select-Object -First 1
  if(-not $symSvg){ $symSvg = Get-ChildItem $tmp -Recurse -Filter *.svg | Where-Object { (Get-Content $_.FullName -Raw) -match '<symbol ' } | Select-Object -First 1 }
  if(-not $symSvg){ throw "No *-symbols.svg (or SVG containing <symbol>) found in the ZIP." }
  $s = [System.IO.File]::ReadAllText($symSvg.FullName)

  $tokens = @{ text='#E8F3E2'; outline='#103700' }
  $mapFile = Get-ChildItem $tmp -Recurse -Filter component-map.json | Select-Object -First 1
  if($mapFile){ try{ $j = Get-Content $mapFile.FullName -Raw | ConvertFrom-Json; if($j.tokens){ if($j.tokens.text){$tokens.text=$j.tokens.text}; if($j.tokens.outline){$tokens.outline=$j.tokens.outline} } }catch{} }

  # shared defs = everything inside the first <defs> up to the first <symbol>
  $defsOpen = $s.IndexOf('<defs>'); $firstSym = $s.IndexOf('<symbol')
  $shared = if($defsOpen -ge 0 -and $firstSym -gt $defsOpen){ $s.Substring($defsOpen+6, $firstSym-($defsOpen+6)) } else { '' }

  function SymUri([string]$id){
    $ss = $s.IndexOf('<symbol id="'+$id+'"'); if($ss -lt 0){ return $null }
    $vbS = $s.IndexOf('viewBox="',$ss)+9; $vbE = $s.IndexOf('"',$vbS); $vb = $s.Substring($vbS,$vbE-$vbS)
    $cs = $s.IndexOf('>',$ss)+1; $ce = $s.IndexOf('</symbol>',$cs); $inner = $s.Substring($cs,$ce-$cs)
    $svg = "<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' viewBox='$vb'><defs>$shared</defs>$inner</svg>"
    $svg = ($svg -replace '\s+',' ').Trim()
    return 'data:image/svg+xml,'+[uri]::EscapeDataString($svg)
  }

  # frame/panel symbols are theme-prefixed (e.g. fall-frame, frozen-panel); fall back to any *-frame/*-panel
  $frameId = if($s.Contains('<symbol id="'+$ThemeId+'-frame"')){ $ThemeId+'-frame' } else { [regex]::Match($s,'<symbol id="([a-z0-9]+-frame)"').Groups[1].Value }
  $panelId = if($s.Contains('<symbol id="'+$ThemeId+'-panel"')){ $ThemeId+'-panel' } else { [regex]::Match($s,'<symbol id="([a-z0-9]+-panel)"').Groups[1].Value }
  $parts = New-Object System.Collections.Generic.List[string]
  $fu = if($frameId){ SymUri $frameId } else { $null }
  if($fu){ $parts.Add('frame:{url:"'+$fu+'",slice:160,repeat:"stretch",width:22,outset:6}') }

  $ctl = New-Object System.Collections.Generic.List[string]
  function AddCtl([string]$role,[string]$id,[string]$extra){ $u = SymUri $id; if($u){ $ctl.Add($role+':{url:"'+$u+'"'+$extra+'}') } }
  AddCtl 'btn'            'button-secondary' (',text:"'+$tokens.text+'"')
  AddCtl 'btnPrimary'     'button-primary'   (',text:"'+$tokens.outline+'"')
  AddCtl 'btnDanger'      'button-danger'    (',text:"'+$tokens.text+'"')
  AddCtl 'toggleOff'      'toggle-off'       ''
  AddCtl 'toggleOn'       'toggle-on'        ''
  AddCtl 'input'          'input-field'      ''
  AddCtl 'checkboxEmpty'  'checkbox-empty'   ''
  AddCtl 'checkboxChecked' 'checkbox-checked' ''
  AddCtl 'radioSelected'  'radio-selected'   ''
  AddCtl 'tabInactive'    'tab-inactive'     ''
  AddCtl 'tabActive'      'tab-active'       ''
  AddCtl 'badge'          'badge'            ''
  AddCtl 'panel'          $panelId           ''
  AddCtl 'chatRichie'     'chat-richie'      (',text:"'+$tokens.text+'"')
  AddCtl 'chatUser'       'chat-user'        (',text:"'+$tokens.text+'"')
  AddCtl 'avatarRing'     'avatar-ring'      ''
  if($ctl.Count){ $parts.Add('controls:{'+($ctl -join ',')+'}') }

  $entry = 'THEME_SKINS.'+$ThemeId+'={'+($parts -join ',')+'};'

  $txt = [System.IO.File]::ReadAllText($App)
  $marker = '/*__THEME_SKINS__*/'
  if($txt.IndexOf($marker) -lt 0){ throw "Marker $marker not found in $App (expected right after 'const THEME_SKINS={};')." }
  $rx = [regex]::new('THEME_SKINS\.'+[regex]::Escape($ThemeId)+'=\{.*?\};',[System.Text.RegularExpressions.RegexOptions]::Singleline)
  $txt = $rx.Replace($txt,'')
  $at = $txt.IndexOf($marker)+$marker.Length
  $txt = $txt.Substring(0,$at)+"`n"+$entry+$txt.Substring($at)
  [System.IO.File]::WriteAllText($App,$txt,(New-Object System.Text.UTF8Encoding($false)))
  Write-Host ("Wired THEME_SKINS.$ThemeId into $App  (" + $ctl.Count + " controls" + $(if($fu){', frame'}else{''}) + ", entry " + $entry.Length + " chars)")
}
finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
