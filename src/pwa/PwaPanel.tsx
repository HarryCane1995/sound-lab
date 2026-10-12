import { useState } from 'react'
import { checkForUpdate, promptInstall, requestUpdate, usePwaState } from './controller'
import './pwa.css'

export function PwaPanel({ blocked, prepare }: { blocked: () => string | null; prepare: () => void }) {
  const state = usePwaState()
  const [later, setLater] = useState(false)
  const reason = blocked()
  if (!import.meta.env.PROD) return null
  return <aside className="pwa-panel" aria-label="Приложение SOUND LAB">
    <div className="pwa-status"><strong>SOUND LAB {__APP_VERSION__}</strong><span>{state.online ? 'Онлайн' : 'Без сети'} · {state.offlineReady ? 'Готово к работе офлайн' : 'Подготовка офлайн-кэша…'}</span>
      {state.needRefresh && later && <button onClick={() => setLater(false)}>Доступна новая версия</button>}
    </div>
    {state.needRefresh && !later && <div className="pwa-update" role="status">
      <span>Доступно обновление SOUND LAB.{reason ? ` ${reason}` : ' Можно загрузить новую версию.'}</span>
      <div className="pwa-actions"><button disabled={!!reason || state.updating} onClick={() => requestUpdate({ blocked, prepare })}>{state.updating ? 'Обновление…' : 'Обновить сейчас'}</button><button disabled={state.updating} onClick={() => setLater(true)}>Позже</button></div>
    </div>}
    {state.error && <p role="status" className="pwa-error">{state.error}</p>}
    <details className="pwa-help"><summary>{state.installed ? 'Приложение установлено · сведения' : 'Установка на Windows и обновления'}</summary>
      {!state.installed && <>
        {state.installAvailable && <button className="pwa-install" onClick={() => void promptInstall()}>Установить приложение</button>}
        <p>Откройте опубликованную HTTPS-версию. Нажмите значок установки в адресной строке. В Chrome также можно выбрать меню ⋮ → «Трансляция, сохранение и отправка» → «Установить SOUND LAB». В Edge: меню ⋯ → «Приложения» → «Установить этот сайт как приложение»; в некоторых версиях «Приложения» находятся в «Других инструментах». Если пункт недоступен, используйте актуальный Chrome или Edge.</p>
        <p>После установки закрепите SOUND LAB на панели задач или создайте ярлык через меню приложения. Оно запускается в отдельном окне без Node.js и локального сервера.</p>
      </>}
      <p>Первое открытие и новые версии требуют интернета. Дождитесь «Готово к работе офлайн». Обновление загружается по подтверждению; перед ним остановите транспорт, сохраните фразу и завершите операции с данными.</p>
      <button disabled={!state.online || state.checking} onClick={() => { setLater(false); void checkForUpdate() }}>{state.checking ? 'Проверка…' : 'Проверить обновления'}</button>
    </details>
  </aside>
}
