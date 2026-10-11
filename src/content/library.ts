import { copyParams, DEFAULT_PARAMS } from '../types'
import type { ADSR, Lesson, Preset, SynthParams } from '../types'

// Every demonstration starts with its own complete, independent parameter set.
function demoParams(overrides: Partial<SynthParams> = {}): SynthParams {
  return copyParams({ ...copyParams(DEFAULT_PARAMS), ...overrides })
}

export const PRESETS: Preset[] = [
  {
    id: 'pure-sine',
    name: 'Чистая синусоида',
    description: 'Один основной тон: начни с него, чтобы услышать высоту звука.',
    params: demoParams({ frequency: 220, amplitude: 0.22 }),
  },
  {
    id: '8-bit-lead',
    name: '8-bit Lead',
    description: 'Прямоугольная волна и быстрая огибающая напоминают звук старых игр.',
    params: demoParams({
      waveform: 'square',
      frequency: 440,
      amplitude: 0.12,
      adsr: { attack: 0.005, decay: 0.12, sustain: 0.55, release: 0.1 },
      filter: { cutoff: 6500, q: 0.707, bypass: false },
    }),
  },
  {
    id: 'soft-bass',
    name: 'Мягкий бас',
    description: 'Низкая треугольная волна, плавное начало и приглушённые верхние частоты.',
    params: demoParams({
      waveform: 'triangle',
      frequency: 110,
      amplitude: 0.28,
      adsr: { attack: 0.04, decay: 0.3, sustain: 0.65, release: 0.3 },
      filter: { cutoff: 600, q: 0.707, bypass: false },
    }),
  },
  {
    id: 'sharp-saw-lead',
    name: 'Резкий пилообразный Lead',
    description: 'Быстрый вход и богатая гармониками пила дают яркий, резкий тембр.',
    params: demoParams({
      waveform: 'sawtooth',
      frequency: 220,
      amplitude: 0.15,
      adsr: { attack: 0.008, decay: 0.15, sustain: 0.65, release: 0.16 },
      filter: { cutoff: 9000, q: 0.8, bypass: false },
    }),
  },
  {
    id: 'evolving-pad',
    name: 'Медленно развивающийся Pad',
    description: 'Долгие Attack и Release; медленный LFO плавно двигает фильтр.',
    params: demoParams({
      waveform: 'sawtooth',
      frequency: 220,
      amplitude: 0.14,
      adsr: { attack: 2.4, decay: 1.2, sustain: 0.65, release: 2.8 },
      filter: { cutoff: 1100, q: 0.707, bypass: false },
      lfo: { enabled: true, rate: 0.35, depth: 0.2, target: 'filter' },
    }),
  },
]

export const ENVELOPE_PRESETS: {
  id: string
  name: string
  description: string
  adsr: ADSR
}[] = [
  {
    id: 'percussive',
    name: 'Короткий удар',
    description: 'Быстрый пик и спад до тишины, даже если нота ещё удерживается.',
    adsr: { attack: 0.005, decay: 0.15, sustain: 0, release: 0.12 },
  },
  {
    id: 'soft-pad',
    name: 'Мягкий пэд',
    description: 'Медленно появляется и долго затихает после отпускания ноты.',
    adsr: { attack: 2, decay: 1, sustain: 0.7, release: 2.5 },
  },
  {
    id: 'organ',
    name: 'Орган',
    description: 'Быстро начинается, держит ровный уровень и быстро заканчивается.',
    adsr: { attack: 0.01, decay: 0.02, sustain: 1, release: 0.07 },
  },
]

export const LESSONS: Lesson[] = [
  {
    id: 'oscillation',
    title: 'Откуда берётся звук',
    shortTitle: 'Колебания',
    explanation: 'Осциллятор создаёт меняющийся сигнал, а динамик превращает его в колебания воздуха. Частота задаёт скорость колебаний, амплитуда — их величину.',
    experiment: 'Нажми Play. Меняй Amplitude от 10% до 25%, сохраняя Frequency = 220 Hz. Затем нажми Stop.',
    listen: 'Звук становится тише или громче, а высота остаётся прежней. Амплитуда влияет на громкость, но слух воспринимает её нелинейно.',
    observe: 'Высота волны и уровень спектра меняются; расстояние между периодами и частота основного пика сохраняются.',
    params: demoParams({ amplitude: 0.2 }),
  },
  {
    id: 'frequency',
    title: 'Почему высокая частота даёт высокий звук',
    shortTitle: 'Высота звука',
    explanation: 'Частота в герцах (Hz) — число колебаний за секунду. Более быстрые колебания воспринимаются как более высокий тон. 220 → 440 Hz — подъём на октаву.',
    experiment: 'Нажми Play. Передвинь Frequency с 220 на 440 Hz, затем верни 220 Hz. Сохрани форму Sine и ту же Amplitude.',
    listen: 'Меняется высота тона. Это отдельное свойство звука: Amplitude управляет уровнем, Waveform — тембром.',
    observe: 'Основной пик смещается с 220 к 440 Hz. Период сокращается вдвое; учитывай автоматический масштаб времени осциллографа.',
    params: demoParams({ frequency: 220, amplitude: 0.2 }),
  },
  {
    id: 'waveform',
    title: 'Как форма волны меняет тембр',
    shortTitle: 'Форма волны',
    explanation: 'Тембр — окраска звука. При той же основной частоте разные формы волны содержат разные сочетания гармоник, поэтому звучат по-разному.',
    experiment: 'Нажми Play при 220 Hz. Переключай Sine → Triangle → Square → Sawtooth. Сохраняй Frequency и Amplitude.',
    listen: 'От мягкого чистого тона переходи к более полному и резкому. Ощущаемая громкость тоже может различаться между формами.',
    observe: 'Осциллограф показывает разные формы; в спектре меняются дополнительные пики, а основной тон остаётся на 220 Hz.',
    params: demoParams({ waveform: 'sine', frequency: 220, amplitude: 0.15 }),
  },
  {
    id: 'harmonics',
    title: 'Что такое гармоники',
    shortTitle: 'Гармоники',
    explanation: 'Гармоники — составляющие на частотах, кратных основному тону. У Sine почти вся энергия в основном тоне; у Sawtooth много гармоник, у Square преобладают нечётные.',
    experiment: 'Нажми Play. Сравни Sine и Sawtooth при 220 Hz, затем выбери Square. Оставь фильтр в Bypass.',
    listen: 'Добавление гармоник делает звук насыщеннее и ярче, хотя основной тон не меняется.',
    observe: 'У пилы ищи пики около 440, 660 и 880 Hz. У Square сильнее нечётные: 660, 1100 Hz. Ширина пиков зависит от разрешения анализа.',
    params: demoParams({ waveform: 'sine', frequency: 220, amplitude: 0.15 }),
  },
  {
    id: 'adsr',
    title: 'Как ADSR меняет характер звука',
    shortTitle: 'Огибающая ADSR',
    explanation: 'Attack ведёт к пику, Decay снижает уровень до Sustain. Sustain — уровень удержания, а не время. Release начинается, когда ты отпускаешь ноту.',
    experiment: 'Нажми Play, подержи звук 3 с, затем нажми Stop и дослушай Release. Повтори, удерживая и отпуская клавишу. Сравни «Короткий удар» и «Мягкий пэд».',
    listen: 'Услышь нарастание, спад до ровного уровня и затухание после отпускания. Длинный Release продолжает звучать после Note Off.',
    observe: 'Меняй Attack и Release: график огибающей растягивается. При игре высота волны и уровни спектра следуют огибающей.',
    params: demoParams({
      waveform: 'sawtooth',
      frequency: 220,
      amplitude: 0.16,
      adsr: { attack: 0.9, decay: 0.6, sustain: 0.35, release: 1.2 },
      filter: { cutoff: 2800, q: 0.707, bypass: false },
    }),
  },
  {
    id: 'filter',
    title: 'Как фильтр убирает частоты',
    shortTitle: 'Low-Pass Filter',
    explanation: 'Low-Pass пропускает низкие частоты и постепенно ослабляет верхние. Cutoff задаёт область среза, Q подчёркивает частоты возле неё. Это меняет тембр.',
    experiment: 'Нажми Play. Уменьшай Cutoff с 8000 до 500 Hz при выключенном Bypass. Сравни с Bypass; затем попробуй Q = 2.',
    listen: 'Яркая пила становится приглушённой. Повышение Q подчёркивает область среза; уровень звука также может измениться.',
    observe: 'Высокие гармоники ослабевают плавно. При росте Q появляется подъём возле Cutoff; Bypass возвращает исходный спектр.',
    params: demoParams({
      waveform: 'sawtooth',
      frequency: 220,
      amplitude: 0.15,
      filter: { cutoff: 8000, q: 0.707, bypass: false },
    }),
  },
  {
    id: 'lfo',
    title: 'Чем LFO отличается от звукового осциллятора',
    shortTitle: 'Движение с LFO',
    explanation: 'Звуковой осциллятор создаёт слышимый тон. LFO здесь медленно меняет его высоту или срез фильтра. Rate — циклы в секунду, Depth — глубина изменения.',
    experiment: 'Нажми Play. Включай и выключай LFO с Target = Pitch. Затем выбери Filter Cutoff и уменьши Rate с 4 до 1 Hz; фильтр должен быть включён.',
    listen: 'Pitch даёт вибрато — колебание высоты. Filter Cutoff создаёт движение тембра; при Depth = 0 модуляция исчезает.',
    observe: 'При Pitch частоты пиков движутся. При Filter меняются уровни гармоник. Увеличение Rate ускоряет эти изменения.',
    params: demoParams({
      waveform: 'sawtooth',
      frequency: 220,
      amplitude: 0.15,
      filter: { cutoff: 1400, q: 0.8, bypass: false },
      lfo: { enabled: true, rate: 4, depth: 0.12, target: 'pitch' },
    }),
  },
]
