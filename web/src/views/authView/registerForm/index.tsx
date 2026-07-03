import { useState, type FormEvent } from 'react';
import { UserOutlined, LockOutlined, MailOutlined, UserAddOutlined } from '@ant-design/icons';
import { registerUser, checkUsernameExists, checkEmailExists } from './api.tsx';
import { type RegisterFormModel } from './type.tsx';
import { useLang } from '@/i18n';
import { useToast } from '@/globalComponents/toast';
import TextInput from '@/globalComponents/textInput';
import PasswordInput from '@/globalComponents/passwordInput';
import Button from '@/globalComponents/button';
import Checkbox from '@/globalComponents/checkbox';
import styles from './style.module.scss';

interface FieldErr {
  username?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
  agreement?: string;
}

const passwordRule = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d@$!%*?&]{6,}$/;
const usernameRule = /^[a-zA-Z0-9_一-龥]+$/;
const emailRule = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function RegisterForm({ switchModel }: { switchModel: () => void }) {
  const toast = useToast();
  const { t } = useLang();

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  // nickname 输入暂时移除,后端入参 fallback 到 username;后续要恢复时在此重建 useState
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [agreement, setAgreement] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<FieldErr>({});

  function validateLocal(): FieldErr {
    const e: FieldErr = {};
    if (!username) e.username = t('auth.validate.usernameRequired');
    else if (username.length < 2) e.username = t('auth.validate.usernameMin');
    else if (!usernameRule.test(username)) e.username = t('auth.validate.usernameRule');

    if (!email) e.email = t('auth.validate.emailRequired');
    else if (!emailRule.test(email)) e.email = t('auth.validate.emailRule');

    if (!password) e.password = t('auth.validate.passwordRequired');
    else if (!passwordRule.test(password)) e.password = t('auth.validate.passwordRule');

    if (!confirmPassword) e.confirmPassword = t('auth.validate.confirmRequired');
    else if (confirmPassword !== password) e.confirmPassword = t('auth.validate.confirmMismatch');

    if (!agreement) e.agreement = t('auth.validate.agreementRequired');
    return e;
  }

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const local = validateLocal();
    setErrors(local);
    if (Object.keys(local).length) {
      toast.err(t('common.invalid'));
      return;
    }
    setLoading(true);
    try {
      // 远端唯一性检查
      const [unameTaken, emailTaken] = await Promise.all([
        checkUsernameExists(username).catch(() => false),
        checkEmailExists(email).catch(() => false),
      ]);
      if (unameTaken || emailTaken) {
        setErrors({
          username: unameTaken ? t('auth.validate.usernameTaken') : undefined,
          email:    emailTaken ? t('auth.validate.emailTaken')    : undefined,
        });
        toast.err(t('common.invalid'));
        return;
      }

      const payload: RegisterFormModel = {
        username, email, password,
        phone: null,
        nickname: username, // nickname 输入暂未启用,fallback 到 username
        avatar: '', bio: '',
      };
      await registerUser(payload);
      toast.ok(t('auth.signup.ok'));
      setTimeout(() => switchModel(), 1500);
    } catch {
      toast.err(t('auth.signup.fail'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.card}>
      {/* <div className={styles.head}>
        <h2 className={styles.title}>{t('auth.signup.title')}</h2>
        <p className={styles.sub}>{t('auth.signup.sub')}</p>
      </div> */}

      <form noValidate onSubmit={onSubmit} className={styles.form}>
        <TextInput
          label={t('auth.fields.username')}
          prefix={<UserOutlined />}
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          error={errors.username}
        />
        <TextInput
          label={t('auth.fields.email')}
          prefix={<MailOutlined />}
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        {/* <TextInput
          label={t('auth.fields.nickname')}
          prefix={<UserOutlined />}
          autoComplete="nickname"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
        /> */}
        <PasswordInput
          label={t('auth.fields.password')}
          prefix={<LockOutlined />}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        <PasswordInput
          label={t('auth.fields.confirmPassword')}
          prefix={<LockOutlined />}
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          error={errors.confirmPassword}
        />

        <div className={styles.agreement}>
          <Checkbox checked={agreement} onChange={setAgreement}>
            {t('auth.fields.agreement')}
          </Checkbox>
          {errors.agreement && <div className={styles.agreementErr}>{errors.agreement}</div>}
        </div>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          block
          loading={loading}
          icon={<UserAddOutlined />}
        >
          {loading ? t('auth.signup.submitting') : t('auth.signup.submit')}
        </Button>
      </form>

      <div className={styles.foot}>
        <Button variant="link" onClick={switchModel} type="button">
          {t('auth.signup.switchToLogin')}
        </Button>
      </div>
    </div>
  );
}

export default RegisterForm;
