; Include do instalador (electron-builder procura build/installer.nsh sozinho).
; Da 0.4.2 em diante o app se chama SagaZap (SagaZap.exe, atalho "SagaZap"). Na atualização a partir do Saga 0.4.1 o
; appId é o mesmo, então o instalador acha a instalação antiga pelo registro, instala na MESMA pasta
; (%LOCALAPPDATA%\Programs\Saga) e o desinstalador antigo apaga Saga.exe e os atalhos "Saga". Isto aqui só garante
; o que ele pode deixar para trás. A pasta de dados (%APPDATA%\saga) não é tocada.
!macro customInstall
  Push $0
  ; atalhos do nome antigo que tenham sobrado (área de trabalho e menu Iniciar)
  Delete "$DESKTOP\Saga.lnk"
  Delete "$SMPROGRAMS\Saga.lnk"
  ; fixado na barra de tarefas: o atalho fixado passa a abrir o SagaZap.exe (a fixação continua no lugar)
  ${if} ${FileExists} "$QUICKLAUNCH\User Pinned\TaskBar\Saga.lnk"
    CreateShortCut "$QUICKLAUNCH\User Pinned\TaskBar\Saga.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$QUICKLAUNCH\User Pinned\TaskBar\Saga.lnk" "${APP_ID}"
  ${endIf}
  ; "Iniciar com o Windows" ligado: o valor (o mesmo que o app grava, LOGIN_ITEM_NAME em src/main/appPaths.ts) passa
  ; a apontar para o SagaZap.exe já agora, mesmo se a atualização foi instalada ao sair e o app só abre no próximo login
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.saga"
  ${if} $0 != ""
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.saga" '"$appExe"'
  ${endIf}
  ClearErrors
  Pop $0
!macroend
