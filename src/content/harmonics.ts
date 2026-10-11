import { defaultAdditive, type AdditiveConfig, type Waveform } from '../types'

export interface HarmonicTemplate {
  id: string
  name: string
  description: string
  classic: Waveform | null
  config: AdditiveConfig
}

function shape(level: (n: number) => number, phase: (n: number) => 0 | 180 = () => 0): AdditiveConfig {
  return { ...defaultAdditive(), levels: Array.from({ length: 16 }, (_, i) => level(i + 1)), phases: Array.from({ length: 16 }, (_, i) => phase(i + 1)) }
}

export const HARMONIC_TEMPLATES: HarmonicTemplate[] = [
  { id: 'pure-sine', name: 'Pure Sine', description: 'Только H1: чистая синусоида и один основной тон.', classic: 'sine', config: defaultAdditive() },
  { id: 'two-harmonics', name: 'Two Harmonics', description: 'H1 = 100%, H2 = 50%: удвоенная частота добавляет окраску прежней ноте.', classic: null, config: shape(n => n === 1 ? 100 : n === 2 ? 50 : 0) },
  { id: 'square-approx', name: 'Square Approximation', description: 'Нечётные гармоники 1/n, фаза 0°. Конечная сумма приближает прямоугольную волну.', classic: 'square', config: shape(n => n % 2 ? 100 / n : 0) },
  { id: 'sawtooth-approx', name: 'Sawtooth Approximation', description: 'Все гармоники 1/n с чередованием 0°/180° для возрастающей пилы.', classic: 'sawtooth', config: shape(n => 100 / n, n => n % 2 ? 0 : 180) },
  { id: 'triangle-approx', name: 'Triangle Approximation', description: 'Нечётные 1/n²; H1, H5… имеют 0°, H3, H7… — 180°. Верхние составляющие быстро ослабевают.', classic: 'triangle', config: shape(n => n % 2 ? 100 / (n * n) : 0, n => n % 4 === 3 ? 180 : 0) },
  { id: 'organ-like', name: 'Organ-like Tone', description: 'Несколько устойчивых гармоник разных уровней: органоподобная окраска, а не реалистичная модель органа.', classic: null, config: shape(n => [100, 15, 45, 30, 0, 12, 0, 8][n - 1] ?? 0) },
]

export const HARMONIC_EXPERIMENTS = [
  {
    id: 'birth', title: '1. Рождение тембра', templateId: 'pure-sine',
    change: 'Начните с H1 = 100%. Нажмите Play при 220 Hz и постепенно добавьте H2, H3 и H4.',
    listen: 'Синусоида становится насыщеннее и ярче. Период основного тона сохраняется.',
    observe: 'В теоретической сумме появляются изгибы; в реальном спектре — пики около 440, 660 и 880 Hz.',
    why: 'Гармоники совершают целое число колебаний за период H1. Они меняют форму повторяющегося цикла, а не базовую частоту ноты.',
  },
  {
    id: 'odd-even', title: '2. Чётные и нечётные', templateId: 'sawtooth-approx',
    change: 'Загрузите пилу, затем отключите H2, H4, H6… H16. Включайте их обратно для сравнения.',
    listen: 'Набор нечётных гармоник даёт более полую окраску; чётные добавляют другой характер яркости.',
    observe: 'Через один пик спектра исчезает. Суммарная волна меняет симметрию и изгибы.',
    why: 'Частоты и относительные уровни составляющих определяют тембр. Нормализация также меняет общий уровень, поэтому сравнивайте прежде всего окраску.',
  },
  {
    id: 'square', title: '3. Собери прямоугольную волну', templateId: 'square-approx',
    change: 'Загрузите Square Approximation. В Compare with Classic переключайте Additive и Classic Square, удерживая одну ноту.',
    listen: 'Тембры похожи, но конечная сумма из восьми нечётных гармоник мягче, чем классическая волна с более высокими составляющими.',
    observe: 'У аппроксимации закруглены края и есть колебания возле переходов. Реальный спектр ограничен H15.',
    why: 'Идеальная прямоугольная волна требует бесконечного ряда нечётных гармоник. Здесь доступны только H1–H16; классический осциллятор также ограничен частотой Найквиста.',
  },
]
