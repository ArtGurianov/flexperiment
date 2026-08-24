/**
 * The controlled set of cities a visitor may request. It is intentionally
 * broader than the live tour: scheduled occurrences are filtered at runtime,
 * not encoded into this catalogue.
 *
 * `timezone` is the city's IANA zone, used to derive an occurrence's
 * timezone on create rather than leaving it free text (C2). Every value is
 * asserted against `Intl.supportedValuesOf("timeZone")` in city-catalog.test.ts.
 */
export const CITY_CATALOGUE = [
  { slug: "moscow", title: "Москва", timezone: "Europe/Moscow" },
  { slug: "saint-petersburg", title: "Санкт-Петербург", timezone: "Europe/Moscow" },
  { slug: "novosibirsk", title: "Новосибирск", timezone: "Asia/Novosibirsk" },
  { slug: "yekaterinburg", title: "Екатеринбург", timezone: "Asia/Yekaterinburg" },
  { slug: "kazan", title: "Казань", timezone: "Europe/Moscow" },
  { slug: "krasnoyarsk", title: "Красноярск", timezone: "Asia/Krasnoyarsk" },
  { slug: "nizhny-novgorod", title: "Нижний Новгород", timezone: "Europe/Moscow" },
  { slug: "chelyabinsk", title: "Челябинск", timezone: "Asia/Yekaterinburg" },
  { slug: "ufa", title: "Уфа", timezone: "Asia/Yekaterinburg" },
  { slug: "samara", title: "Самара", timezone: "Europe/Samara" },
  { slug: "rostov-on-don", title: "Ростов-на-Дону", timezone: "Europe/Moscow" },
  { slug: "krasnodar", title: "Краснодар", timezone: "Europe/Moscow" },
  { slug: "omsk", title: "Омск", timezone: "Asia/Omsk" },
  { slug: "voronezh", title: "Воронеж", timezone: "Europe/Moscow" },
  { slug: "perm", title: "Пермь", timezone: "Asia/Yekaterinburg" },
  { slug: "volgograd", title: "Волгоград", timezone: "Europe/Volgograd" },
  { slug: "saratov", title: "Саратов", timezone: "Europe/Saratov" },
  { slug: "tyumen", title: "Тюмень", timezone: "Asia/Yekaterinburg" },
  { slug: "tolyatti", title: "Тольятти", timezone: "Europe/Samara" },
  { slug: "makhachkala", title: "Махачкала", timezone: "Europe/Moscow" },
  { slug: "barnaul", title: "Барнаул", timezone: "Asia/Barnaul" },
  { slug: "izhevsk", title: "Ижевск", timezone: "Europe/Samara" },
  { slug: "khabarovsk", title: "Хабаровск", timezone: "Asia/Vladivostok" },
  { slug: "ulyanovsk", title: "Ульяновск", timezone: "Europe/Ulyanovsk" },
  { slug: "irkutsk", title: "Иркутск", timezone: "Asia/Irkutsk" },
  { slug: "vladivostok", title: "Владивосток", timezone: "Asia/Vladivostok" },
  { slug: "yaroslavl", title: "Ярославль", timezone: "Europe/Moscow" },
  { slug: "kemerovo", title: "Кемерово", timezone: "Asia/Novokuznetsk" },
  { slug: "tomsk", title: "Томск", timezone: "Asia/Tomsk" },
  { slug: "naberezhnye-chelny", title: "Набережные Челны", timezone: "Europe/Moscow" },
  { slug: "sevastopol", title: "Севастополь", timezone: "Europe/Simferopol" },
  { slug: "stavropol", title: "Ставрополь", timezone: "Europe/Moscow" },
  { slug: "orenburg", title: "Оренбург", timezone: "Asia/Yekaterinburg" },
  { slug: "novokuznetsk", title: "Новокузнецк", timezone: "Asia/Novokuznetsk" },
  { slug: "ryazan", title: "Рязань", timezone: "Europe/Moscow" },
  { slug: "penza", title: "Пенза", timezone: "Europe/Moscow" },
  { slug: "cheboksary", title: "Чебоксары", timezone: "Europe/Moscow" },
  { slug: "lipetsk", title: "Липецк", timezone: "Europe/Moscow" },
  { slug: "kaliningrad", title: "Калининград", timezone: "Europe/Kaliningrad" },
  { slug: "astrakhan", title: "Астрахань", timezone: "Europe/Astrakhan" },
  { slug: "tula", title: "Тула", timezone: "Europe/Moscow" },
  { slug: "kirov", title: "Киров", timezone: "Europe/Kirov" },
  { slug: "sochi", title: "Сочи", timezone: "Europe/Moscow" },
  { slug: "ulan-ude", title: "Улан-Удэ", timezone: "Asia/Irkutsk" },
  { slug: "kursk", title: "Курск", timezone: "Europe/Moscow" },
  { slug: "surgut", title: "Сургут", timezone: "Asia/Yekaterinburg" },
  { slug: "tver", title: "Тверь", timezone: "Europe/Moscow" },
  { slug: "magnitogorsk", title: "Магнитогорск", timezone: "Asia/Yekaterinburg" },
  { slug: "grozny", title: "Грозный", timezone: "Europe/Moscow" },
  { slug: "yakutsk", title: "Якутск", timezone: "Asia/Yakutsk" },
  { slug: "bryansk", title: "Брянск", timezone: "Europe/Moscow" },
  { slug: "ivanovo", title: "Иваново", timezone: "Europe/Moscow" },
  { slug: "vladimir", title: "Владимир", timezone: "Europe/Moscow" },
  { slug: "chita", title: "Чита", timezone: "Asia/Chita" },
  { slug: "belgorod", title: "Белгород", timezone: "Europe/Moscow" },
  { slug: "kaluga", title: "Калуга", timezone: "Europe/Moscow" },
  { slug: "volzhsky", title: "Волжский", timezone: "Europe/Volgograd" },
  { slug: "smolensk", title: "Смоленск", timezone: "Europe/Moscow" },
  { slug: "saransk", title: "Саранск", timezone: "Europe/Moscow" },
  { slug: "vologda", title: "Вологда", timezone: "Europe/Moscow" },
  { slug: "cherepovets", title: "Череповец", timezone: "Europe/Moscow" },
  { slug: "arkhangelsk", title: "Архангельск", timezone: "Europe/Moscow" },
  { slug: "vladikavkaz", title: "Владикавказ", timezone: "Europe/Moscow" },
  { slug: "orel", title: "Орёл", timezone: "Europe/Moscow" },
  { slug: "yoshkar-ola", title: "Йошкар-Ола", timezone: "Europe/Moscow" },
  { slug: "sterlitamak", title: "Стерлитамак", timezone: "Asia/Yekaterinburg" },
  { slug: "kostroma", title: "Кострома", timezone: "Europe/Moscow" },
  { slug: "murmansk", title: "Мурманск", timezone: "Europe/Moscow" },
  { slug: "novorossiysk", title: "Новороссийск", timezone: "Europe/Moscow" },
  { slug: "tambov", title: "Тамбов", timezone: "Europe/Moscow" },
  { slug: "nizhnevartovsk", title: "Нижневартовск", timezone: "Asia/Yekaterinburg" },
  { slug: "nalchik", title: "Нальчик", timezone: "Europe/Moscow" },
  { slug: "taganrog", title: "Таганрог", timezone: "Europe/Moscow" },
  { slug: "blagoveshchensk", title: "Благовещенск", timezone: "Asia/Yakutsk" },
  { slug: "komsomolsk-on-amur", title: "Комсомольск-на-Амуре", timezone: "Asia/Vladivostok" },
  { slug: "petrozavodsk", title: "Петрозаводск", timezone: "Europe/Moscow" },
  { slug: "nizhnekamsk", title: "Нижнекамск", timezone: "Europe/Moscow" },
  { slug: "abakan", title: "Абакан", timezone: "Asia/Krasnoyarsk" },
] as const;

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
