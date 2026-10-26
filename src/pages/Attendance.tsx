import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { CheckCircle2, AlertTriangle, Loader2, RotateCw } from 'lucide-react';
import { useI18n, weekDayLabel } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { Spinner, EmptyState } from '@/components/ui';
import { isoDate, weekDayOf } from '@/lib/utils';
import type { ClassRow, Lesson, Student, AttendanceRecord, AttendanceStatus } from '@/lib/types';

type SelMap = Record<string, AttendanceStatus>;
type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export default function Attendance() {
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [selClass, setSelClass] = useState('');
  const [date, setDate] = useState(isoDate(new Date()));
  const [students, setStudents] = useState<Student[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [existing, setExisting] = useState<AttendanceRecord[]>([]);
  const [sel, setSel] = useState<SelMap>({});
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [retryFn, setRetryFn] = useState<(() => Promise<void>) | null>(null);

  const instId = profile?.institution_id;

  // Pending write queue: list of single-change operations to flush.
  // Each entry describes the desired state for one (student, lesson) pair.
  type PendingOp = {
    studentId: string;
    lessonId: string;
    status: AttendanceStatus | null; // null = delete (present)
    lesson: Lesson;
  };
  const pendingRef = useRef<PendingOp[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushingRef = useRef(false);
  const classDateRef = useRef({ selClass: '', date: '' });

  async function loadClasses() {
    if (!instId) return;
    const { data } = await supabase.from('classes').select('*').eq('institution_id', instId).eq('archived', false).order('name');
    const cls = (data ?? []) as ClassRow[];
    setClasses(cls);
    if (cls.length && !selClass) setSelClass(cls[0].id);
  }

  useEffect(() => { loadClasses(); }, [instId]);

  const loadDay = useCallback(async (cls: string, dt: string) => {
    if (!cls || !dt) return;
    setLoading(true);
    setSaveState('idle');
    const wd = weekDayOf(new Date(dt)) as Lesson['week_day'];

    const [stuRes, lesRes, attRes] = await Promise.all([
      supabase.from('students').select('*').eq('class_id', cls).eq('archived', false).order('last_name'),
      supabase.from('lessons').select('*').eq('class_id', cls).eq('week_day', wd).order('start_time'),
      supabase.from('attendance_records').select('*').eq('class_id', cls).eq('record_date', dt),
    ]);

    setStudents((stuRes.data ?? []) as Student[]);
    setLessons((lesRes.data ?? []) as Lesson[]);
    const atts = (attRes.data ?? []) as AttendanceRecord[];
    setExisting(atts);

    const dayLessonIds = new Set((lesRes.data ?? []).map((l: { id: string }) => l.id));
    const m: SelMap = {};
    for (const a of atts) {
      if (a.lesson_id && dayLessonIds.has(a.lesson_id)) {
        m[`${a.student_id}__${a.lesson_id}`] = a.status;
      }
    }
    setSel(m);
    pendingRef.current = [];
    setLoading(false);
  }, []);

  // Flush all pending writes when class or date changes
  const flushPending = useCallback(async (): Promise<void> => {
    if (flushingRef.current) return;
    const ops = pendingRef.current.slice();
    if (ops.length === 0) return;
    flushingRef.current = true;
    setSaveState('saving');
    try {
      await applyOps(ops, classDateRef.current.selClass, classDateRef.current.date, instId!);
      pendingRef.current = [];
      setSaveState('saved');
    } catch {
      setSaveState('failed');
      // Keep pending ops so user can retry
    }
    flushingRef.current = false;
  }, [instId]);

  useEffect(() => {
    classDateRef.current = { selClass, date };
    // Before loading new day, flush any pending writes for the *previous* day
    (async () => {
      await flushPending();
      await loadDay(selClass, date);
    })();
  }, [selClass, date, flushPending, loadDay]);

  // Warn before leaving with unsaved changes
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (pendingRef.current.length > 0 || flushingRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // Core: apply a batch of single-change operations to the DB
  const applyOps = useCallback(async (ops: PendingOp[], cls: string, dt: string, inst: string) => {
    // Build existing map from current state
    const existingMap = new Map<string, AttendanceRecord>();
    for (const a of existing) {
      if (a.lesson_id) existingMap.set(`${a.student_id}__${a.lesson_id}`, a);
    }

    const toInsert: Record<string, unknown>[] = [];
    const toUpdate: { id: string; status: AttendanceStatus }[] = [];
    const toDelete: string[] = [];

    for (const op of ops) {
      const key = `${op.studentId}__${op.lessonId}`;
      const ex = existingMap.get(key);
      if (op.status === null) {
        // present => delete record if exists
        if (ex) toDelete.push(ex.id);
      } else {
        if (ex) {
          if (ex.status !== op.status) toUpdate.push({ id: ex.id, status: op.status });
        } else {
          toInsert.push({
            institution_id: inst,
            class_id: cls,
            student_id: op.studentId,
            lesson_id: op.lessonId,
            record_date: dt,
            subject_snapshot: op.lesson.subject,
            start_time_snapshot: op.lesson.start_time,
            end_time_snapshot: op.lesson.end_time,
            duration_minutes_snapshot: op.lesson.duration_minutes,
            status: op.status,
            recorded_by: profile?.user_id ?? null,
          });
        }
      }
    }

    if (toDelete.length) {
      const { error } = await supabase.from('attendance_records').delete().in('id', toDelete);
      if (error) throw error;
    }
    for (const u of toUpdate) {
      const { error } = await supabase.from('attendance_records').update({ status: u.status }).eq('id', u.id);
      if (error) throw error;
    }
    if (toInsert.length) {
      const { error } = await supabase.from('attendance_records').insert(toInsert);
      if (error) throw error;
    }

    // Refresh existing records from DB so subsequent diffs are correct
    const { data: fresh } = await supabase.from('attendance_records').select('*').eq('class_id', cls).eq('record_date', dt);
    setExisting((fresh ?? []) as AttendanceRecord[]);
  }, [existing, profile?.user_id]);

  // Enqueue a single change and schedule a debounced flush
  const enqueueChange = useCallback((op: PendingOp) => {
    pendingRef.current.push(op);
    setSaveState('saving');
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => {
      flushPending();
    }, 600);
  }, [flushPending]);

  // Retry a failed flush
  const retry = useCallback(async () => {
    setRetryFn(null);
    await flushPending();
  }, [flushPending]);

  // Toggle absent/present for a student-lesson
  const toggle = (studentId: string, lesson: Lesson) => {
    const key = `${studentId}__${lesson.id}`;
    const current = sel[key];
    const newStatus: AttendanceStatus | null = current === 'absent' ? null : 'absent';
    setSel((prev) => {
      const next = { ...prev };
      if (newStatus === null) delete next[key];
      else next[key] = newStatus;
      return next;
    });
    enqueueChange({ studentId, lessonId: lesson.id, status: newStatus, lesson });
  };

  // Set a specific status (present/excused)
  const setStatus = (studentId: string, lesson: Lesson, status: AttendanceStatus) => {
    const key = `${studentId}__${lesson.id}`;
    const newStatus: AttendanceStatus | null = status === 'present' ? null : status;
    setSel((prev) => {
      const next = { ...prev };
      if (newStatus === null) delete next[key];
      else next[key] = newStatus;
      return next;
    });
    enqueueChange({ studentId, lessonId: lesson.id, status: newStatus, lesson });
  };

  const studentTotalMinutes = (s: Student) => {
    let mins = 0;
    for (const l of lessons) {
      const st = sel[`${s.id}__${l.id}`];
      if (st === 'absent') mins += l.duration_minutes;
    }
    return mins;
  };

  const sortedLessons = useMemo(() => [...lessons].sort((a, b) => a.start_time.localeCompare(b.start_time)), [lessons]);
  const weekday = weekDayOf(new Date(date));

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap gap-3 items-end sticky top-16 z-10" style={{ background: 'var(--surface)' }}>
        <div>
          <label className="label">{t('select_class')}</label>
          <select className="input min-w-[160px]" value={selClass} onChange={(e) => setSelClass(e.target.value)}>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">{t('select_date')}</label>
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="text-sm text-muted ms-auto">{weekDayLabel(weekday, lang)}</div>
      </div>

      {!selClass ? <div className="card"><EmptyState text={t('select_class')} /></div> :
        loading ? <Spinner label={t('loading')} /> :
        students.length === 0 ? <div className="card"><EmptyState text={t('empty')} /></div> :
        lessons.length === 0 ? <div className="card"><EmptyState text={t('no_lessons_today')} /></div> : (
          <>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 text-sm">
                {saveState === 'saving' && (
                  <span className="flex items-center gap-1.5 text-[var(--warning)]">
                    <Loader2 size={16} className="animate-spin" />
                    {t('saving_attendance')}
                  </span>
                )}
                {saveState === 'saved' && (
                  <span className="flex items-center gap-1 text-[var(--success)]">
                    <CheckCircle2 size={16} />{t('saved')}
                  </span>
                )}
                {saveState === 'failed' && (
                  <span className="flex items-center gap-2 text-[var(--error)]">
                    <AlertTriangle size={16} />
                    {t('save_failed')}
                    <button onClick={retry} className="btn btn-ghost btn p-1">
                      <RotateCw size={14} />{t('retry')}
                    </button>
                  </span>
                )}
              </div>
            </div>

            <div className="card overflow-x-auto p-0">
              <table className="w-full text-sm border-collapse">
                <thead className="surface-2">
                  <tr>
                    <th className="sticky-col text-start px-3 py-2 font-medium border-b border-app z-20" style={{ minWidth: 140 }}>{t('students')}</th>
                    {sortedLessons.map((l) => (
                      <th key={l.id} className="px-2 py-2 font-medium border-b border-app text-center" style={{ minWidth: 110 }}>
                        <div>{l.subject}</div>
                        <div className="text-xs text-muted font-normal">{l.start_time}-{l.end_time}</div>
                        <div className="text-xs text-muted font-normal">{l.duration_minutes}{t('minutes')}</div>
                      </th>
                    ))}
                    <th className="px-3 py-2 font-medium border-b border-app text-center">{t('total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {students.map((s) => {
                    const total = studentTotalMinutes(s);
                    return (
                      <tr key={s.id} className="border-b border-app">
                        <td className="sticky-col px-3 py-2 font-medium border-e border-app z-10" style={{ background: 'var(--surface)' }}>
                          {s.last_name} {s.first_name}
                        </td>
                        {sortedLessons.map((l) => {
                          const key = `${s.id}__${l.id}`;
                          const status = sel[key];
                          const isAbsent = status === 'absent';
                          const isExcused = status === 'excused';
                          return (
                            <td key={l.id} className="px-2 py-2 text-center border-e border-app">
                              <div className="flex flex-col items-center gap-1">
                                <button
                                  onClick={() => toggle(s.id, l)}
                                  className="w-10 h-10 rounded-lg flex items-center justify-center text-xs font-bold transition-all"
                                  style={isAbsent
                                    ? { background: 'var(--error)', color: 'white', boxShadow: '0 0 0 2px color-mix(in srgb, var(--error) 30%, transparent)' }
                                    : isExcused
                                      ? { background: 'color-mix(in srgb, var(--warning) 18%, transparent)', color: 'var(--warning)' }
                                      : { background: 'var(--surface-2)', color: 'var(--text-muted)' }}
                                  title={isAbsent ? t('absent') : isExcused ? t('excused') : t('present')}
                                >
                                  {isAbsent ? 'X' : isExcused ? 'E' : '✓'}
                                </button>
                                <div className="flex gap-1">
                                  <button onClick={() => setStatus(s.id, l, 'present')} className="text-[10px] px-1.5 rounded" style={{ background: 'var(--surface-2)' }}>{t('present').slice(0, 1)}</button>
                                  <button onClick={() => setStatus(s.id, l, 'excused')} className="text-[10px] px-1.5 rounded" style={{ background: 'color-mix(in srgb, var(--warning) 14%, transparent)', color: 'var(--warning)' }}>{t('excused').slice(0, 1)}</button>
                                </div>
                              </div>
                            </td>
                          );
                        })}
                        <td className="px-3 py-2 text-center font-bold" style={{ color: total > 0 ? 'var(--error)' : 'var(--text-muted)' }}>
                          {Math.floor(total / 60)}h {total % 60}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
    </div>
  );
}
