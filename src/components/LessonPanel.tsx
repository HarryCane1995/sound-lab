import { useState } from 'react'
import { LESSONS } from '../content/library'
import type { Lesson } from '../types'

export function LessonPanel({ onLoad, loadedLesson }: { onLoad: (lesson: Lesson) => void; loadedLesson: string | null }) {
  const [index, setIndex] = useState(0)
  const [done, setDone] = useState<Set<string>>(new Set())
  const lesson = LESSONS[index]
  const completed = done.has(lesson.id)
  const mark = () => setDone(previous => { const next = new Set(previous); if (next.has(lesson.id)) next.delete(lesson.id); else next.add(lesson.id); return next })
  return <aside className="learning-sidebar" aria-label="Интерактивное обучение">
    <div className="lesson-panel panel">
      <div className="lesson-header"><span className="eyebrow"><span className="small-spark">✳</span> ПРАКТИКА ВМЕСТО ТЕОРИИ</span><h2>Что я сейчас<br />изучаю?</h2><p>Семь маленьких открытий.<br />Один большой мир звука.</p></div>
      <nav className="lesson-nav" aria-label="Выбор урока">{LESSONS.map((item, itemIndex) => <button key={item.id} aria-current={itemIndex === index ? 'step' : undefined} onClick={() => setIndex(itemIndex)}><span className={`lesson-number ${done.has(item.id) ? 'complete' : ''}`}>{done.has(item.id) ? '✓' : String(itemIndex + 1).padStart(2, '0')}</span><span>{item.shortTitle}</span><span className="lesson-chevron">↗</span></button>)}</nav>
      <div className="lesson-detail" key={lesson.id}>
        <div className="lesson-counter">ЭКСПЕРИМЕНТ {String(index + 1).padStart(2, '0')} <span>/ 07</span></div>
        <h3>{lesson.title}</h3><p>{lesson.explanation}</p>
        <button className="demo-button" onClick={() => onLoad(lesson)}><span aria-hidden="true">↳</span> {loadedLesson === lesson.id ? 'Загрузить демо снова' : 'Загрузить демо'}</button>
        <span className="demo-note">Настройки загрузятся без запуска звука.<br />Затем нажмите Play или удерживайте ноту.</span>
        <div className="experiment"><span className="eyebrow">ПОПРОБУЙТЕ</span><p>{lesson.experiment}</p></div>
        <div className="observation"><span className="observation-icon" aria-hidden="true">◖</span><div><span>Услышать</span><p>{lesson.listen}</p></div></div>
        <div className="observation"><span className="observation-icon" aria-hidden="true">⌁</span><div><span>Увидеть</span><p>{lesson.observe}</p></div></div>
        <button className={`complete-lesson ${completed ? 'is-complete' : ''}`} aria-pressed={completed} onClick={mark}><span>{completed ? '✓' : '○'}</span>{completed ? 'Открытие сделано' : 'Я это попробовал'}</button>
      </div>
      <div className="learning-progress"><div><span>Ваши открытия</span><span>{done.size} из 7</span></div><div className="progress-track"><span style={{ width: `${done.size / 7 * 100}%` }} /></div><small>Порядок свободный. Прогресс — в этой сессии.</small></div>
    </div>
    <div className="sidebar-note"><span>НАЧНИТЕ С ТИХОГО ЗВУКА</span><p>25% — исходный уровень сигнала. Подстройте громкость наушников или колонок перед первым опытом.</p></div>
  </aside>
}
