/**
 * The controlled set of cities a visitor may request. It is intentionally
 * broader than the live tour: scheduled occurrences are filtered at runtime,
 * not encoded into this catalogue.
 */
export const CITY_CATALOGUE = [
  { slug: "moscow", title: "Москва" },
  { slug: "saint-petersburg", title: "Санкт-Петербург" },
  { slug: "novosibirsk", title: "Новосибирск" },
  { slug: "yekaterinburg", title: "Екатеринбург" },
  { slug: "kazan", title: "Казань" },
  { slug: "krasnoyarsk", title: "Красноярск" },
  { slug: "nizhny-novgorod", title: "Нижний Новгород" },
  { slug: "chelyabinsk", title: "Челябинск" },
  { slug: "ufa", title: "Уфа" },
  { slug: "samara", title: "Самара" },
  { slug: "rostov-on-don", title: "Ростов-на-Дону" },
  { slug: "krasnodar", title: "Краснодар" },
  { slug: "omsk", title: "Омск" },
  { slug: "voronezh", title: "Воронеж" },
  { slug: "perm", title: "Пермь" },
  { slug: "volgograd", title: "Волгоград" },
  { slug: "saratov", title: "Саратов" },
  { slug: "tyumen", title: "Тюмень" },
  { slug: "tolyatti", title: "Тольятти" },
  { slug: "makhachkala", title: "Махачкала" },
  { slug: "barnaul", title: "Барнаул" },
  { slug: "izhevsk", title: "Ижевск" },
  { slug: "khabarovsk", title: "Хабаровск" },
  { slug: "ulyanovsk", title: "Ульяновск" },
  { slug: "irkutsk", title: "Иркутск" },
  { slug: "vladivostok", title: "Владивосток" },
  { slug: "yaroslavl", title: "Ярославль" },
  { slug: "kemerovo", title: "Кемерово" },
  { slug: "tomsk", title: "Томск" },
  { slug: "naberezhnye-chelny", title: "Набережные Челны" },
  { slug: "sevastopol", title: "Севастополь" },
  { slug: "stavropol", title: "Ставрополь" },
  { slug: "orenburg", title: "Оренбург" },
  { slug: "novokuznetsk", title: "Новокузнецк" },
  { slug: "ryazan", title: "Рязань" },
  { slug: "penza", title: "Пенза" },
  { slug: "cheboksary", title: "Чебоксары" },
  { slug: "lipetsk", title: "Липецк" },
  { slug: "kaliningrad", title: "Калининград" },
  { slug: "astrakhan", title: "Астрахань" },
  { slug: "tula", title: "Тула" },
  { slug: "kirov", title: "Киров" },
  { slug: "sochi", title: "Сочи" },
  { slug: "ulan-ude", title: "Улан-Удэ" },
  { slug: "kursk", title: "Курск" },
  { slug: "surgut", title: "Сургут" },
  { slug: "tver", title: "Тверь" },
  { slug: "magnitogorsk", title: "Магнитогорск" },
  { slug: "grozny", title: "Грозный" },
  { slug: "yakutsk", title: "Якутск" },
  { slug: "bryansk", title: "Брянск" },
  { slug: "ivanovo", title: "Иваново" },
  { slug: "vladimir", title: "Владимир" },
  { slug: "chita", title: "Чита" },
  { slug: "belgorod", title: "Белгород" },
  { slug: "kaluga", title: "Калуга" },
  { slug: "volzhsky", title: "Волжский" },
  { slug: "smolensk", title: "Смоленск" },
  { slug: "saransk", title: "Саранск" },
  { slug: "vologda", title: "Вологда" },
  { slug: "cherepovets", title: "Череповец" },
  { slug: "arkhangelsk", title: "Архангельск" },
  { slug: "vladikavkaz", title: "Владикавказ" },
  { slug: "orel", title: "Орёл" },
  { slug: "yoshkar-ola", title: "Йошкар-Ола" },
  { slug: "sterlitamak", title: "Стерлитамак" },
  { slug: "kostroma", title: "Кострома" },
  { slug: "murmansk", title: "Мурманск" },
  { slug: "novorossiysk", title: "Новороссийск" },
  { slug: "tambov", title: "Тамбов" },
  { slug: "nizhnevartovsk", title: "Нижневартовск" },
  { slug: "nalchik", title: "Нальчик" },
  { slug: "taganrog", title: "Таганрог" },
  { slug: "blagoveshchensk", title: "Благовещенск" },
  { slug: "komsomolsk-on-amur", title: "Комсомольск-на-Амуре" },
  { slug: "petrozavodsk", title: "Петрозаводск" },
  { slug: "nizhnekamsk", title: "Нижнекамск" },
  { slug: "abakan", title: "Абакан" },
] as const;

export const CITY_SLUGS = CITY_CATALOGUE.map(({ slug }) => slug) as [
  (typeof CITY_CATALOGUE)[number]["slug"],
  ...(typeof CITY_CATALOGUE)[number]["slug"][],
];

export type CityCatalogueEntry = (typeof CITY_CATALOGUE)[number];
export type CitySlug = CityCatalogueEntry["slug"];
export type CityTitle = CityCatalogueEntry["title"];

const catalogueBySlug = new Map<string, CityCatalogueEntry>(CITY_CATALOGUE.map((city) => [city.slug, city]));

export const isCitySlug = (value: string): value is CitySlug => catalogueBySlug.has(value);

export const findCityBySlug = (value: string): CityCatalogueEntry | undefined => catalogueBySlug.get(value);

export const getCityBySlug = (slug: CitySlug): CityCatalogueEntry => {
  const city = findCityBySlug(slug);
  if (!city) throw new Error(`Unknown canonical city slug: ${slug}`);
  return city;
};

export const requestableCities = (scheduledCitySlugs: Iterable<CitySlug>) => {
  const scheduled = new Set(scheduledCitySlugs);
  return CITY_CATALOGUE.filter((city) => !scheduled.has(city.slug));
};
