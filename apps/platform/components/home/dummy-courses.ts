// PLACEHOLDER CONTENT. These courses, their copy and their covers are stand-ins for the carousel
// prototype; none of them is a catalogue entry. Replace with the published catalogue before the
// home page is released.

export type OrbitCourse = {
  slug: string;
  title: string;
  level: string;
  lessons: number;
  duration: string;
  summary: string;
  outline: [string, string, string];
  image: string;
  href: string;
};

const cover = (index: number) => `/dummy/courses/course-${String(index).padStart(2, "0")}.svg`;

export const dummyCourses: OrbitCourse[] = [
  {
    slug: "groove", title: "Грув и баунс", level: "База", lessons: 12, duration: "3 ч 40 мин",
    summary: "С чего начинается флексинг: вес, пульс и расслабленное тело, которое держит ритм без усилия.",
    outline: ["Баунс и перенос веса", "Пульс корпуса под разный темп", "Первая связка на грув"],
    image: cover(1), href: "/courses",
  },
  {
    slug: "gliding", title: "Глайдинг", level: "База", lessons: 10, duration: "2 ч 55 мин",
    summary: "Скольжение без рывков: работа стопы, смена опоры и иллюзия движения по льду.",
    outline: ["Механика стопы и опоры", "Боковой и круговой глайд", "Глайд внутри фристайла"],
    image: cover(2), href: "/courses",
  },
  {
    slug: "waving", title: "Вейвинг", level: "Средний", lessons: 14, duration: "4 ч 10 мин",
    summary: "Волна как непрерывная линия: от кисти до стопы, с контролем скорости и направления.",
    outline: ["Волна рук по точкам", "Волна корпуса и переходы", "Смена скорости внутри волны"],
    image: cover(3), href: "/courses",
  },
  {
    slug: "bone-breaking", title: "Бон-брейкинг", level: "Продвинутый", lessons: 16, duration: "5 ч 20 мин",
    summary: "Безопасная подвижность плеч и иллюзии «сломанных» линий — с подготовкой суставов в каждом уроке.",
    outline: ["Подготовка плечевого пояса", "Базовые замки и выходы", "Связки и работа с паузой"],
    image: cover(4), href: "/courses",
  },
  {
    slug: "pauzin", title: "Пауза и акцент", level: "Средний", lessons: 9, duration: "2 ч 30 мин",
    summary: "Остановка как высказывание: как замирать вовремя и делать акцент, который слышно глазами.",
    outline: ["Стоп-кадр и дыхание", "Акцент на сильную долю", "Контраст скорости и тишины"],
    image: cover(5), href: "/courses",
  },
  {
    slug: "connecting", title: "Коннектинг", level: "Средний", lessons: 11, duration: "3 ч 15 мин",
    summary: "Связываем элементы в одну фразу, чтобы движение не рассыпалось на отдельные трюки.",
    outline: ["Точки соединения рук", "Переходы между уровнями", "Фраза на восемь счётов"],
    image: cover(6), href: "/courses",
  },
  {
    slug: "musicality", title: "Музыкальность", level: "Любой уровень", lessons: 8, duration: "2 ч 45 мин",
    summary: "Учимся слышать трек слоями — бит, бас, вокал — и выбирать, на что отвечает тело.",
    outline: ["Разбор трека по слоям", "Счёт, слайд и синкопа", "Импровизация под задачу"],
    image: cover(7), href: "/courses",
  },
  {
    slug: "freestyle-lab", title: "Фристайл-лаборатория", level: "Продвинутый", lessons: 15, duration: "4 ч 50 мин",
    summary: "Собираем личный словарь: задания, ограничения и разборы, после которых появляется свой почерк.",
    outline: ["Задания на ограничения", "Работа с историей в сете", "Разбор собственных записей"],
    image: cover(8), href: "/courses",
  },
  {
    slug: "hat-tricks", title: "Хэт-трюки", level: "Средний", lessons: 10, duration: "2 ч 20 мин",
    summary: "Кепка как партнёр: перекаты, перехваты и броски, встроенные в движение, а не вместо него.",
    outline: ["Хваты и перекаты по руке", "Броски и ловля в ритм", "Трюк внутри связки"],
    image: cover(9), href: "/courses",
  },
  {
    slug: "get-low", title: "Гет-лоу", level: "Продвинутый", lessons: 13, duration: "3 ч 50 мин",
    summary: "Работа в нижнем уровне: входы в партер, смена высоты и сила, которая не ломает грув.",
    outline: ["Входы и выходы из партера", "Смена уровней под музыку", "Выносливость и контроль корпуса"],
    image: cover(10), href: "/courses",
  },
];
