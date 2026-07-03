import { useLang } from '@/i18n';
import { PROJECTS, pick } from '../models';
import styles from './works.module.scss';

function Works() {
  const { t, lang } = useLang();

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.eyebrow}>
          {String(PROJECTS.length).padStart(2, '0')} · {t('auth.works.title')}
        </div>
        <h1 className={styles.title}>{t('auth.works.title')}</h1>
        <p className={styles.subtitle}>{t('auth.works.subtitle')}</p>
      </header>

      <div className={styles.list}>
        {PROJECTS.map((p, i) => (
          <article key={p.name.zh} className={styles.item}>
            <aside className={styles.itemSide}>
              <div className={styles.num}>{String(i + 1).padStart(2, '0')}</div>
              <div className={styles.year}>{p.year}</div>
              <div className={styles.role}>{pick(lang, p.role)}</div>
            </aside>

            <div className={styles.itemBody}>
              <div className={styles.itemHead}>
                <h2 className={styles.name}>{pick(lang, p.name)}</h2>
                <p className={styles.tagline}>{pick(lang, p.tagline)}</p>
              </div>
              <p className={styles.detail}>{pick(lang, p.detail)}</p>
              {p.highlights && (
                <ul className={styles.points}>
                  {p.highlights[lang].map((h, j) => <li key={j}>{h}</li>)}
                </ul>
              )}
              <div className={styles.stack}>
                {p.stack.map((s) => <span key={s} className={styles.chip}>{s}</span>)}
              </div>
            </div>
          </article>
        ))}
      </div>

      <footer className={styles.foot}>
        <span>{t('auth.works.more')}</span>
      </footer>
    </div>
  );
}

export default Works;
