# notify-applied.ps1
# Paso final del workflow n8n: verifica bot WhatsApp + muestra notificacion de resumen.
# Llamado por n8n despues de scan.mjs y batch-auto.mjs.

$base    = "C:\Users\victo\OneDrive\Escritorio\Automatizacion de Busquedas\career-ops"
$botUrl  = "http://127.0.0.1:3099/health"
$file    = Join-Path $base "data\applications.md"

# ── 1. Verificar estado del bot WhatsApp ──────────────────────────────────────
$botRunning    = $false
$pendingOffers = 0

try {
    $response = Invoke-RestMethod -Uri $botUrl -Method GET -TimeoutSec 4 -ErrorAction Stop
    if ($response.ok -eq $true) {
        $botRunning    = $true
        $pendingOffers = [int]$response.pending
    }
} catch {
    $botRunning = $false
}

Write-Output "bot_running=$botRunning | pending_whatsapp=$pendingOffers"

# ── 2. Contar postulaciones activas en tracker ────────────────────────────────
$appliedCount = 0
$companyList  = ""

if (Test-Path $file) {
    $rows = @(Get-Content $file | Where-Object {
        $_ -match "^\s*\|" -and $_ -match "\|\s*Applied\s*\|"
    })
    $appliedCount = $rows.Count

    if ($appliedCount -gt 0) {
        $companies = @($rows | ForEach-Object {
            $parts = $_ -split "\|"
            if ($parts.Length -ge 4) { $parts[3].Trim() }
        } | Where-Object { $_ -ne "" } | Select-Object -First 5)

        $companyList = $companies -join ", "
        if ($appliedCount -gt 5) { $companyList += " (+$($appliedCount - 5) mas)" }
    }
}

Write-Output "applied_count=$appliedCount companies=$companyList"

# ── 3. Notificacion Windows ───────────────────────────────────────────────────
Add-Type -AssemblyName System.Windows.Forms
$notify         = New-Object System.Windows.Forms.NotifyIcon
$notify.Visible = $true

if (-not $botRunning) {
    $notify.Icon = [System.Drawing.SystemIcons]::Warning
    $title = "Career-Ops: Bot WhatsApp NO activo"
    $msg   = "El scan termino pero el bot no esta corriendo. Ejecuta start-bot.bat para recibir vacantes por WhatsApp."
} elseif ($pendingOffers -gt 0) {
    $notify.Icon = [System.Drawing.SystemIcons]::Information
    $title = "Career-Ops: $pendingOffers vacante(s) en WhatsApp"
    $msg   = "Revisa tu WhatsApp y responde 1 (postular) o 2 (rechazar) a cada oferta."
} elseif ($appliedCount -gt 0) {
    $notify.Icon = [System.Drawing.SystemIcons]::Information
    $title = "Career-Ops: $appliedCount postulacion(es) activas"
    $msg   = "Esperando respuesta de: $companyList"
} else {
    $notify.Icon = [System.Drawing.SystemIcons]::Information
    $title = "Career-Ops: Scan completado"
    $msg   = "No hay nuevas vacantes que superen el score minimo ahora."
}

$notify.ShowBalloonTip(10000, $title, $msg, [System.Windows.Forms.ToolTipIcon]::Info)
Start-Sleep -Seconds 11
$notify.Dispose()
