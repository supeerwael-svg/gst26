import { useEffect, useState } from 'react';
import { CalendarClock, Plus, Trash2, AlertCircle } from 'lucide-react';
import { useI18n, weekDayLabel } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { Modal, EmptyState, Spinner } from '@/components/ui';
import { DEFAULT_WORKING_DAYS, type ClassRow, type Lesson, type WeekDay } from '@/lib/types';
import { timeToMinutes } from '@/lib/utils';

const HOURS = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
const MINUTES = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'];

function timeOptions(): string[] {
  const out: string[] = [];
  for (const h of HOURS) for (const m of MINUTES) out.push(`${h.split(':')[0]}:${m}`);
  return out;
}
const TIMES = timeOptions();

export default function Timetables() {
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [selClass, setSelClass] = useState('');
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ week_day: 'sunday' as WeekDay, subject: '', start_time: '08:00', end_time: '09:00' });
  const [overlapWarn, setOverlapWarn] = useState<string | null>(null);

  const instId = profile?.institution_id;

  async function loadClasses() {
    if (!instId) return;
    const { data } = await supabase.from('classes').select('*').eq('institution_id', instId).eq('archived', false).order('name');
    const cls = (data ?? []) as ClassRow[];
    setClasses(cls);
    if (cls.length && !selClass) setSelClass(cls[0].id);
  }

  useEffect(() => { loadClasses(); }, [instId]);

  async function loadLessons() {
    if (!selClass) return;
    setLoading(true);
    const { data } = await supabase.from('lessons').select('*').eq('class_id', selClass).order('week_day').order('start_time');
    setLessons((data ?? []) as Lesson[]);
    setLoading(false);
  }

  useEffect(() => { loadLessons(); }, [selClass]);

  const lessonsByDay = (day: WeekDay) => lessons.filter((l) => l.week_day === day);

  const addLesson = async () => {
    if (!selClass || !form.subject.trim()) return;
    if (timeToMinutes(form.end_time) <= timeToMinutes(form.start_time)) return;
    // overlap detection
    const dayLessons = lessonsByDay(form.week_day);
    const s = timeToMinutes(form.start_time), e = timeToMinutes(form.end_time);
    const conflict = dayLessons.find((l) => {
      const ls = timeToMinutes(l.start_time), le = timeToMinutes(l.end_time);
      return s < le && e > ls;
    });
    if (conflict) {
      setOverlapWarn(`${conflict.subject} ${conflict.start_time}-${conflict.end_time}`);
      return;
    }
    setOverlapWarn(null);
    await supabase.from('lessons').insert({
      class_id: selClass, week_day: form.week_day, subject: form.subject.trim(),
      start_time: form.start_time, end_time: form.end_time,
    });
    setModal(false);
    setForm({ week_day: 'sunday', subject: '', start_time: '08:00', end_time: '09:00' });
    loadLessons();
  };

  const removeLesson = async (id: string) => {
    await supabase.from('lessons').delete().eq('id', id);
    loadLessons();
  };

  const totalMinutesWeek = lessons.reduce((s, l) => s + l.duration_minutes, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <select className="input max-w-xs" value={selClass} onChange={(e) => setSelClass(e.target.value)}>
          {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted">{t('total')}: {Math.floor(totalMinutesWeek / 60)}h {totalMinutesWeek % 60}{t('minutes')}</span>
          <button onClick={() => setModal(true)} className="btn btn-primary" disabled={!selClass}><Plus size={18} />{t('subject')}</button>
        </div>
      </div>

      {!selClass ? <div className="card"><EmptyState icon={<CalendarClock size={40} />} text={t('empty')} /></div> :
        loading ? <Spinner label={t('loading')} /> : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {DEFAULT_WORKING_DAYS.map((day) => (
              <div key={day} className="card">
                <h3 className="font-semibold mb-3">{weekDayLabel(day, lang)}</h3>
                {lessonsByDay(day).length === 0 ? (
                  <p className="text-sm text-muted py-4 text-center">{t('no_lessons_today')}</p>
                ) : (
                  <div className="space-y-2">
                    {lessonsByDay(day).sort((a, b) => a.start_time.localeCompare(b.start_time)).map((l) => (
                      <div key={l.id} className="flex items-center justify-between surface-2 rounded-lg px-3 py-2">
                        <div>
                          <div className="font-medium text-sm">{l.subject}</div>
                          <div className="text-xs text-muted">{l.start_time} - {l.end_time} ({l.duration_minutes}{t('minutes')})</div>
                        </div>
                        <button onClick={() => removeLesson(l.id)} className="btn btn-ghost p-1.5 text-[var(--error)]"><Trash2 size={14} /></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

      <Modal open={modal} onClose={() => { setModal(false); setOverlapWarn(null); }} title={t('subject')}>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="label">{t('subject')}</label>
            <input className="input" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} autoFocus />
          </div>
          <div>
            <label className="label">{t('date')}</label>
            <select className="input" value={form.week_day} onChange={(e) => setForm({ ...form, week_day: e.target.value as WeekDay })}>
              {DEFAULT_WORKING_DAYS.map((d) => <option key={d} value={d}>{weekDayLabel(d, lang)}</option>)}
            </select>
          </div>
          <div>
            <label className="label">{t('start_time')}</label>
            <select className="input" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })}>
              {TIMES.map((tm) => <option key={tm} value={tm}>{tm}</option>)}
            </select>
          </div>
          <div>
            <label className="label">{t('end_time')}</label>
            <select className="input" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })}>
              {TIMES.map((tm) => <option key={tm} value={tm}>{tm}</option>)}
            </select>
          </div>
        </div>
        {overlapWarn && (
          <div className="mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-sm" style={{ background: 'color-mix(in srgb, var(--warning) 12%, transparent)', color: 'var(--warning)' }}>
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{t('error')}: {overlapWarn}</span>
          </div>
        )}
        {timeToMinutes(form.end_time) <= timeToMinutes(form.start_time) && (
          <div className="mt-3 text-sm" style={{ color: 'var(--error)' }}>{t('end_time')} &gt; {t('start_time')}</div>
        )}
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={() => { setModal(false); setOverlapWarn(null); }} className="btn btn-ghost">{t('cancel')}</button>
          <button onClick={addLesson} className="btn btn-primary">{t('save')}</button>
        </div>
      </Modal>
    </div>
  );
}
