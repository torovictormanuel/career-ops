# setup-autostart.ps1 — Registra n8n y el bot de WhatsApp como tareas automáticas
# Ejecutar UNA VEZ como administrador.
# Después de esto, ambos servicios arrancan solos al iniciar sesión en Windows.

$careerOps = "C:\Users\victo\OneDrive\Escritorio\Automatizacion de Busquedas\career-ops"
$node       = "C:\Program Files\nodejs\node.exe"
$n8nBin     = "C:\Users\victo\AppData\Roaming\npm\node_modules\n8n\bin\n8n"
$user       = $env:USERNAME

# ─────────────────────────────────────────────────────────────────────────────
# TAREA 1: WhatsApp Bot
# ─────────────────────────────────────────────────────────────────────────────
$waBotAction  = New-ScheduledTaskAction `
    -Execute    $node `
    -Argument   "`"$careerOps\whatsapp-bot.mjs`"" `
    -WorkingDirectory $careerOps

# Arranca al logon + 20 seg de delay (espera que la red este lista)
$waBotTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERDOMAIN\$user
$waBotTrigger.Delay = "PT20S"

$waBotSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit         (New-TimeSpan -Days 0)   `
    -RestartCount               10                        `
    -RestartInterval            (New-TimeSpan -Minutes 2) `
    -MultipleInstances          IgnoreNew                 `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName   "career-ops-whatsapp-bot" `
    -TaskPath   "\career-ops\" `
    -Action     $waBotAction `
    -Trigger    $waBotTrigger `
    -Settings   $waBotSettings `
    -RunLevel   Limited `
    -Force | Out-Null

Write-Host "[OK] Tarea registrada: career-ops-whatsapp-bot (arranca 20 seg despues del login)"

# ─────────────────────────────────────────────────────────────────────────────
# TAREA 2: n8n
# ─────────────────────────────────────────────────────────────────────────────
$n8nAction  = New-ScheduledTaskAction `
    -Execute    $node `
    -Argument   "`"$n8nBin`" start" `
    -WorkingDirectory $env:USERPROFILE

# Arranca al logon + 10 seg de delay
$n8nTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERDOMAIN\$user
$n8nTrigger.Delay = "PT10S"

$n8nSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit         (New-TimeSpan -Days 0)   `
    -RestartCount               10                        `
    -RestartInterval            (New-TimeSpan -Minutes 2) `
    -MultipleInstances          IgnoreNew                 `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName   "career-ops-n8n" `
    -TaskPath   "\career-ops\" `
    -Action     $n8nAction `
    -Trigger    $n8nTrigger `
    -Settings   $n8nSettings `
    -RunLevel   Limited `
    -Force | Out-Null

Write-Host "[OK] Tarea registrada: career-ops-n8n (arranca 10 seg despues del login)"

# ─────────────────────────────────────────────────────────────────────────────
# ARRANCAR AHORA (sin esperar al próximo login)
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Arrancando servicios ahora..."

# n8n (si no esta corriendo)
$n8nRunning = $false
try {
    $r = Invoke-WebRequest -Uri "http://localhost:5678/healthz" -TimeoutSec 3 -ErrorAction Stop
    $n8nRunning = ($r.StatusCode -eq 200)
} catch { $n8nRunning = $false }

if ($n8nRunning) {
    Write-Host "[OK] n8n ya esta corriendo en localhost:5678"
} else {
    Start-Process -FilePath $node -ArgumentList "`"$n8nBin`" start" -WorkingDirectory $env:USERPROFILE -WindowStyle Minimized
    Write-Host "[OK] n8n iniciado (minimizado)"
}

# WhatsApp bot (si no esta corriendo)
$botRunning = $false
try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:3099/health" -TimeoutSec 3 -ErrorAction Stop
    $botRunning = $r.ok
} catch { $botRunning = $false }

if ($botRunning) {
    Write-Host "[OK] WhatsApp bot ya esta corriendo en localhost:3099"
} else {
    Start-Process -FilePath $node -ArgumentList "`"$careerOps\whatsapp-bot.mjs`"" -WorkingDirectory $careerOps -WindowStyle Minimized
    Write-Host "[OK] WhatsApp bot iniciado (minimizado)"
    Write-Host ""
    Write-Host "IMPORTANTE: Si es la primera vez, abri la ventana minimizada en la barra"
    Write-Host "y escaneá el QR con WhatsApp > Dispositivos vinculados."
    Write-Host "Después de eso, nunca mas vas a necesitar hacerlo."
}

Write-Host ""
Write-Host "================================================"
Write-Host " Setup completo. A partir de ahora:"
Write-Host " - Al iniciar Windows, todo arranca solo."
Write-Host " - n8n escanea a las 8am, 1pm y 6pm."
Write-Host " - Las vacantes llegan directo a tu WhatsApp."
Write-Host "================================================"
Write-Host ""
pause
