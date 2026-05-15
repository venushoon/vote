import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, LabelList, Cell,
} from "recharts";
import QRCode from "react-qr-code";
import { ref, onValue, set, update, runTransaction, remove } from "firebase/database";
import type { DataSnapshot } from "firebase/database";
import { db, ensureAuth } from "./firebase";

/* ========= Types & utils ========= */
type Visibility = "always" | "hidden" | "deadline";
type AuthMode = "open" | "roster";
type VoteLimit = 1 | 2;
type Option = { id: string; label: string; votes: number };
type Ballot = { ids: string[]; at: number; name?: string | null };
type GraphDatum = { name: string; votes: number; _i: number };

const DEFAULT_DESC = "설명을 입력하세요. 예) 체험학습 장소를 골라요!";
const LS_PID_KEY = "vote_last_pid";
const ADMIN_PIN = import.meta.env.VITE_ADMIN_PIN;

const uuid = () =>
  (window.crypto as any)?.randomUUID?.() ||
  `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;

const getView = (): "admin" | "student" =>
  location.hash === "#student" ? "student" : "admin";

const pollPath = (pid: string) => `polls/${pid}`;

const getPidFromURL = (): string => {
  try { return new URL(location.href).searchParams.get("pid") || ""; }
  catch { return ""; }
};

const defaultState = () => {
  const opts: Option[] = [
    { id: uuid(), label: "보기 1", votes: 0 },
    { id: uuid(), label: "보기 2", votes: 0 },
  ];
  return {
    title: "새로운 결정 투표",
    desc: DEFAULT_DESC,
    voteLimit: 1 as VoteLimit,
    options: opts,
    ballots: {} as Record<string, Ballot>,
    anonymous: false,
    visibilityMode: "always" as Visibility,
    authMode: "open" as AuthMode,
    voterList: [] as string[],
    deadlineAt: null as number | null,
    expectedVoters: 0,
    manualClosed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
};

/* ========= Color palette for bars ========= */
const COLORS = [
  "#6366F1", "#10B981", "#F59E0B", "#EF4444", "#06B6D4",
  "#A855F7", "#84CC16", "#3B82F6", "#EC4899", "#F97316",
];

/* ========= Interfaces ========= */
interface AdminViewProps {
  currentPid: string;
  allPolls: Record<string, any>;
  switchPoll: (pid: string) => void;
  createNewPoll: () => Promise<void>;
  deletePoll: (pid: string) => Promise<void>;
  togglePollStatus: (pid: string, isClosed: boolean) => Promise<void>;
  desc: string;
  setDesc: (v: string) => Promise<void>;
  voteLimit: VoteLimit;
  setVoteLimit: (v: VoteLimit) => Promise<void>;
  options: Option[];
  setOptionLabel: (id: string, label: string) => void;
  addOption: () => Promise<void>;
  removeOption: (id: string) => Promise<void>;
  recountVotes: () => Promise<void>;
  ballots: Record<string, Ballot>;
  anonymous: boolean;
  setAnonymous: (b: boolean) => Promise<void>;
  visibilityMode: Visibility;
  setVisibilityMode: (m: Visibility) => Promise<void>;
  authMode: AuthMode;
  setAuthMode: (m: AuthMode) => Promise<void>;
  voterList: string[];
  setVoterList: (list: string[]) => Promise<void>;
  deadlineAt: number | null;
  setDeadlineAt: (t: number | null) => Promise<void>;
  totalVotes: number;
  graphData: GraphDatum[];
  isVisible: boolean;
  expectedVotersText: string;
  onExpectedChange: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  isClosed: boolean;
  closeNow: () => Promise<void>;
  reopen: () => Promise<void>;
  saveHint: string;
  saveToCloud: () => Promise<void>;
  studentLink: string;
  copyStudentLink: () => void;
  showLink: boolean;
  setShowLink: React.Dispatch<React.SetStateAction<boolean>>;
  resetAllToDefaults: () => Promise<void>;
  removeVoter: (id: string) => Promise<void>;
  isWorking: boolean;
  setIsFullscreen: React.Dispatch<React.SetStateAction<boolean>>;
}

interface StudentViewProps {
  desc: string;
  options: Option[];
  voteLimit: VoteLimit;
  anonymous: boolean;
  visibilityMode: Visibility;
  authMode: AuthMode;
  voterList: string[];
  deadlineAt: number | null;
  isVisible: boolean;
  voterName: string;
  setVoterName: (v: string) => void;
  selected: string[];
  setSelected: React.Dispatch<React.SetStateAction<string[]>>;
  submitVote: () => Promise<boolean>;
  totalVotes: number;
  graphData: GraphDatum[];
  isClosed: boolean;
  pidReady: boolean;
  isWorking: boolean;
}

/* ========= App ========= */
export default function App() {
  const [viewMode, setViewMode] = useState<"admin" | "student">(getView());
  const [adminAuthed, setAdminAuthed] = useState(!ADMIN_PIN); 
  const [pinInput, setPinInput] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onHash = () => setViewMode(getView());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const [isBooting, setIsBooting] = useState(true);
  const [isWorking, setIsWorking] = useState(false);

  const [pollId, setPollId] = useState<string>("");
  const [allPolls, setAllPolls] = useState<Record<string, any>>({});

  const [title, setTitle] = useState("우리 반 결정 투표");
  const [desc, setDesc] = useState(DEFAULT_DESC);
  const [voteLimit, setVoteLimit] = useState<VoteLimit>(1);
  const [options, setOptions] = useState<Option[]>([]);
  const [ballots, setBallots] = useState<Record<string, Ballot>>({});
  const [anonymous, setAnonymous] = useState(false);
  const [visibilityMode, setVisibilityMode] = useState<Visibility>("always");
  const [authMode, setAuthMode] = useState<AuthMode>("open");
  const [voterList, setVoterList] = useState<string[]>([]);
  const [deadlineAt, setDeadlineAt] = useState<number | null>(null);
  const [expectedVoters, setExpectedVoters] = useState(0);
  const [expectedVotersText, setExpectedVotersText] = useState("0");
  const [manualClosed, setManualClosed] = useState(false);

  const [saveHint, setSaveHint] = useState("");
  const [linkVersion, setLinkVersion] = useState(0);
  const [showLink, setShowLink] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ---------- Timer for real-time deadline check ---------- */
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000); 
    return () => clearInterval(timer);
  }, []);

  /* ---------- pid helpers ---------- */
  const setPidEverywhere = useCallback((pid: string) => {
    if (!pid) return;
    setPollId(pid);
    localStorage.setItem(LS_PID_KEY, pid);
    const u = new URL(location.href);
    u.searchParams.set("pid", pid);
    history.replaceState({}, "", u.toString());
  }, []);

  useEffect(() => {
    if (viewMode === "admin" && adminAuthed) {
      const unsub = onValue(ref(db, "polls"), (snap) => {
        setAllPolls(snap.val() || {});
      });
      return () => unsub();
    }
  }, [viewMode, adminAuthed]);

  useEffect(() => {
    async function boot() {
      await ensureAuth();
      const initPid = getPidFromURL() || localStorage.getItem(LS_PID_KEY);
      if (initPid) {
        setPidEverywhere(initPid);
      } else {
        const newPid = Math.random().toString(36).slice(2, 8);
        await set(ref(db, pollPath(newPid)), defaultState());
        setPidEverywhere(newPid);
      }
    }
    boot();
  }, [setPidEverywhere]);

  useEffect(() => {
    if (!pollId) return;
    const unsub = onValue(
      ref(db, pollPath(pollId)),
      (snap: DataSnapshot) => {
        const data = snap.val();
        if (!data) return;
        setTitle(data.title ?? "우리 반 결정 투표");
        setDesc(data.desc ?? DEFAULT_DESC);
        setVoteLimit((data.voteLimit as VoteLimit) ?? 1);
        setOptions(Array.isArray(data.options) ? data.options : []);
        setBallots(data.ballots ?? {});
        setAnonymous(!!data.anonymous);
        setVisibilityMode((data.visibilityMode as Visibility) ?? "always");
        setAuthMode((data.authMode as AuthMode) ?? "open");
        setVoterList(Array.isArray(data.voterList) ? data.voterList : []);
        setDeadlineAt(data.deadlineAt ?? null);
        const ev = Number(data.expectedVoters ?? 0);
        const evSafe = isNaN(ev) ? 0 : ev;
        setExpectedVoters(evSafe);
        setExpectedVotersText(String(evSafe));
        setManualClosed(!!data.manualClosed);
        setIsBooting(false);
      },
      (err) => {
        console.error("구독 실패:", err);
        setIsBooting(false);
      }
    );
    return () => unsub();
  }, [pollId]);

  /* ---------- Dashboard Control Functions ---------- */
  const createNewPoll = async () => {
    setIsWorking(true);
    const newPid = Math.random().toString(36).slice(2, 8);
    await set(ref(db, pollPath(newPid)), defaultState());
    setPidEverywhere(newPid);
    setLinkVersion((v) => v + 1);
    setIsWorking(false);
  };

  const switchPoll = (pid: string) => {
    setPidEverywhere(pid);
    setLinkVersion((v) => v + 1);
  };

  const deletePoll = async (pid: string) => {
    if (!confirm("정말 이 투표를 완전히 삭제하시겠습니까?\n(데이터 복구 불가)")) return;
    setIsWorking(true);
    await remove(ref(db, pollPath(pid)));
    if (pid === pollId) {
      await createNewPoll();
    }
    setIsWorking(false);
  };

  const togglePollStatus = async (pid: string, isClosed: boolean) => {
    await update(ref(db, pollPath(pid)), { manualClosed: !isClosed, updatedAt: Date.now() });
  };

  const patchPoll = async (fields: Partial<any>) => {
    if (!pollId) return;
    await ensureAuth();
    await update(ref(db, pollPath(pollId)), { ...fields, updatedAt: Date.now() });
  };

  /* ---------- derived ---------- */
  const totalVotes = useMemo(
    () => options.reduce((a: number, b: Option) => a + (b?.votes ?? 0), 0),
    [options]
  );
  const votedCount = useMemo(() => Object.keys(ballots).length, [ballots]);
  const autoClosed = useMemo(
    () => expectedVoters > 0 && votedCount >= expectedVoters,
    [expectedVoters, votedCount]
  );
  const isClosed = manualClosed || autoClosed;

  const baseVisible = useMemo(() => {
    if (visibilityMode === "always") return true;
    if (visibilityMode === "hidden") return false;
    if (!deadlineAt) return false;
    return now >= deadlineAt;
  }, [visibilityMode, deadlineAt, now]);

  const isVisibleAdmin = visibilityMode === "hidden" ? true : baseVisible;
  const isVisibleStudent = baseVisible;

  const graphData: GraphDatum[] = useMemo(
    () => options.map((o: Option, idx) => ({ name: o.label, votes: o.votes, _i: idx })),
    [options]
  );

  /* ---------- student link / QR ---------- */
  const studentLink = useMemo(() => {
    const u = new URL(location.href);
    if (pollId) u.searchParams.set("pid", pollId);
    u.hash = "#student";
    u.searchParams.set("v", String(linkVersion));
    return u.toString();
  }, [pollId, linkVersion]);

  const copyStudentLink = () =>
    navigator.clipboard.writeText(studentLink).then(() => {
      setSaveHint("학생용 링크를 복사했어요.");
      setTimeout(() => setSaveHint(""), 3000);
    });

  /* ---------- save / mutate ---------- */
  const saveToCloud = async () => {
    try {
      setIsWorking(true);
      await ensureAuth();
      await update(ref(db, pollPath(pollId)), {
        title, desc, voteLimit, options, anonymous,
        visibilityMode, authMode, voterList, deadlineAt, expectedVoters, manualClosed,
        updatedAt: Date.now(),
      });
      setLinkVersion((v) => v + 1);
      setSaveHint("저장됨 (QR/링크 반영)");
      setTimeout(() => setSaveHint(""), 3000);
    } catch (e) {
      console.error(e);
      alert("저장 중 문제가 발생했습니다.");
    } finally {
      setIsWorking(false);
    }
  };

  const addOption = async () => {
    try {
      setIsWorking(true);
      await ensureAuth();
      await runTransaction(ref(db, pollPath(pollId)), (data: any) => {
        const d = data || defaultState();
        const current: Option[] = Array.isArray(d.options) ? d.options : [];
        const nextIndex = current.length + 1;
        const newItem: Option = { id: uuid(), label: `보기 ${nextIndex}`, votes: 0 };
        const next: Option[] = [...current, newItem];
        return { ...d, options: next, updatedAt: Date.now() };
      });
      setSaveHint("옵션을 추가했어요.");
      setLinkVersion((v) => v + 1);
    } catch (e) {
      console.error(e);
      alert("옵션 추가 중 문제가 발생했습니다.");
    } finally {
      setIsWorking(false);
    }
  };

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setOptionLabel = (id: string, label: string) => {
    setOptions((prev: Option[]) => {
      const next = prev.map((o: Option) => (o.id === id ? { ...o, label } : o));
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        void patchPoll({ options: next });
      }, 500); 
      return next;
    });
  };

  const removeOption = async (id: string) => {
    try {
      setIsWorking(true);
      await ensureAuth();
      await runTransaction(ref(db, pollPath(pollId)), (data: any) => {
        if (!data) return data;
        const current: Option[] = Array.isArray(data.options) ? data.options : [];
        const next: Option[] = current.filter((o: Option) => o.id !== id);

        const ballotsObj = data.ballots || {};
        const newBallots: Record<string, Ballot> = {};
        Object.entries(ballotsObj).forEach(([k, info]) => {
          const b = info as Ballot;
          newBallots[k] = { ...b, ids: (b.ids || []).filter((x) => x !== id) };
        });

        const countMap: Record<string, number> = {};
        next.forEach((o: Option) => (countMap[o.id] = 0));
        Object.values(newBallots).forEach((b) =>
          (b.ids || []).forEach((oid) => (countMap[oid] = (countMap[oid] || 0) + 1))
        );

        const fixedOptions: Option[] = next.map((o: Option) => ({ ...o, votes: countMap[o.id] || 0 }));
        return { ...data, options: fixedOptions, ballots: newBallots, updatedAt: Date.now() };
      });
      setSaveHint("옵션을 삭제했어요.");
      setLinkVersion((v) => v + 1);
    } catch (e) {
      console.error(e);
      alert("옵션 삭제 중 문제가 발생했습니다.");
    } finally {
      setIsWorking(false);
    }
  };

  const recountVotes = async () => {
    try {
      setIsWorking(true);
      await ensureAuth();
      await runTransaction(ref(db, pollPath(pollId)), (data: any) => {
        if (!data) return data;
        const opts: Option[] = data.options || [];
        const ballotsObj = data.ballots || {};
        const countMap: Record<string, number> = {};
        opts.forEach((o: Option) => (countMap[o.id] = 0));
        Object.values(ballotsObj).forEach((b: any) =>
          (b.ids || []).forEach((oid: string) => (countMap[oid] = (countMap[oid] || 0) + 1))
        );
        const fixed: Option[] = opts.map((o: Option) => ({ ...o, votes: countMap[o.id] || 0 }));
        return { ...data, options: fixed, updatedAt: Date.now() };
      });
      setSaveHint("표를 재계산했어요.");
    } catch (e) {
      console.error(e);
      alert("재계산 중 오류가 발생했습니다.");
    } finally {
      setIsWorking(false);
    }
  };

  /* ---------- vote submit ---------- */
  const [voterName, setVoterName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const getStudentKey = (pid: string, isAnonymous: boolean, authMode: AuthMode, voterNameInput: string): string => {
    if (authMode === "roster") {
      return `roster_${voterNameInput.trim()}`;
    }
    if (isAnonymous) {
      const keyName = `vote_device_token_${pid || "temp"}`;
      let key: string = localStorage.getItem(keyName) || "";
      if (!key) {
        key = uuid();
        localStorage.setItem(keyName, key);
      }
      return key;
    }
    return voterNameInput.trim();
  };

  const submitVote = async (): Promise<boolean> => {
    try {
      setIsWorking(true);
      await ensureAuth();
      
      const vName = voterName.trim();
      if (authMode === "roster" || !anonymous) {
        if (!vName) { alert("이름/번호를 입력하세요."); return false; }
      }
      
      if (authMode === "roster" && !voterList.includes(vName)) {
        alert("선생님이 등록하신 명단에 없는 이름(번호)입니다.\n정확하게 입력했는지 확인해주세요.");
        return false;
      }

      if (selected.length === 0) { alert("선택한 보기가 없습니다."); return false; }

      const key = getStudentKey(pollId, anonymous, authMode, vName);

      const res = await runTransaction(ref(db, pollPath(pollId)), (data: any) => {
        if (!data) return data;
        if (data.manualClosed || (data.expectedVoters > 0 && Object.keys(data.ballots || {}).length >= data.expectedVoters)) {
          return; 
        }
        const ballotsObj = data.ballots || {};
        if (ballotsObj[key]) return data; 

        if (data.authMode === 'roster') {
           const alreadyVoted = Object.values(ballotsObj).some((b: any) => b.name === vName || b.originalName === vName);
           if (alreadyVoted) return data;
        }

        const ids = selected.slice(0, data.voteLimit || 1);
        const nowMs = Date.now();

        ballotsObj[key] = {
          ids,
          at: nowMs,
          name: data.anonymous ? null : vName,
          originalName: vName 
        };

        const opts: Option[] = (data.options || []).map((o: Option) => ({ ...o }));
        ids.forEach((oid: string) => {
          const idx = opts.findIndex((o: Option) => o.id === oid);
          if (idx >= 0) opts[idx].votes = (opts[idx].votes || 0) + 1;
        });

        return { ...data, ballots: ballotsObj, options: opts, updatedAt: Date.now() };
      });

      if ((res as any)?.committed) {
        setVoterName("");
        setSelected([]);
        return true;
      } else {
        alert("이미 투표를 완료했거나 마감되었습니다.");
        return false;
      }
    } catch (e) {
      console.error(e);
      alert("제출 중 오류가 발생했습니다.");
      return false;
    } finally {
      setIsWorking(false);
    }
  };

  /* ---------- remove voter ---------- */
  const removeVoter = async (id: string) => {
    try {
      if (!confirm(`이 투표 내역을 삭제할까요?\n(명단 기반일 경우 해당 학생은 다시 투표 가능해집니다)`)) return;
      setIsWorking(true);
      await ensureAuth();
      await runTransaction(ref(db, pollPath(pollId)), (data: any) => {
        if (!data) return data;
        const ballotsObj = { ...(data.ballots || {}) };
        const info = ballotsObj[id] as Ballot | undefined;
        if (!info) return data;
        delete ballotsObj[id];

        const opts: Option[] = (data.options || []).map((o: Option) => ({ ...o }));
        (info.ids || []).forEach((oid: string) => {
          const idx = opts.findIndex((o: Option) => o.id === oid);
          if (idx >= 0) opts[idx].votes = Math.max(0, (opts[idx].votes || 0) - 1);
        });

        return { ...data, ballots: ballotsObj, options: opts, updatedAt: Date.now() };
      });
    } catch (e) {
      console.error(e);
      alert("투표 삭제 중 오류가 발생했습니다.");
    } finally {
      setIsWorking(false);
    }
  };

  /* ---------- reset to defaults ---------- */
  const resetAllToDefaults = async () => {
    try {
      if (!confirm("현재 방의 모든 설정과 결과를 기본값으로 초기화할까요?")) return;
      setIsWorking(true);
      await ensureAuth();
      await set(ref(db, pollPath(pollId)), defaultState());
      setSaveHint("기본값으로 초기화됨");
    } catch (e) {
      console.error(e);
      alert("초기화 중 오류가 발생했습니다.");
    } finally {
      setIsWorking(false);
    }
  };

  /* ---------- close / reopen ---------- */
  const closeNow = async () => {
    await ensureAuth();
    await update(ref(db, pollPath(pollId)), { manualClosed: true, updatedAt: Date.now() });
  };
  const reopen = async () => {
    await ensureAuth();
    await update(ref(db, pollPath(pollId)), { manualClosed: false, updatedAt: Date.now() });
  };

  /* ---------- JSON / CSV / load ---------- */
  const download = (filename: string, text: string, mime = "application/json") => {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const saveJSON = () => {
    const payload = JSON.stringify(
      {
        title, desc, voteLimit, options, ballots,
        anonymous, visibilityMode, authMode, voterList, deadlineAt,
        expectedVoters, manualClosed, pollId: pollId,
      },
      null, 2
    );
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    download(`vote-result-${stamp}.json`, payload, "application/json");
    setSaveHint("JSON으로 저장했어요.");
  };

  const saveCSV = () => {
    const head = "option,votes\n";
    const rows = options.map((o: Option) => `${escapeCSV(o.label)},${o.votes}`).join("\n");
    const csv = head + rows;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    download(`vote-summary-${stamp}.csv`, csv, "text/csv");
    setSaveHint("CSV 요약을 저장했어요.");
  };

  const escapeCSV = (s: string) => {
    if (s == null) return "";
    const needs = /[",\n]/.test(s);
    const out = String(s).replace(/"/g, '""');
    return needs ? `"${out}"` : out;
  };

  const loadFromFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(String(ev.target?.result || "{}"));
        if (typeof data.title === "string") setTitle(data.title);
        if (typeof data.desc === "string") setDesc(data.desc);
        if (data.voteLimit === 1 || data.voteLimit === 2) setVoteLimit(data.voteLimit as VoteLimit);
        if (Array.isArray(data.options)) setOptions(data.options as Option[]);
        if (data.ballots && typeof data.ballots === "object") setBallots(data.ballots as Record<string, Ballot>);
        if (typeof data.anonymous === "boolean") setAnonymous(data.anonymous);
        if (data.visibilityMode) setVisibilityMode(data.visibilityMode as Visibility);
        if (data.authMode) setAuthMode(data.authMode as AuthMode);
        if (Array.isArray(data.voterList)) setVoterList(data.voterList as string[]);
        setDeadlineAt(data.deadlineAt ?? null);

        const evNum = Number(data.expectedVoters ?? 0);
        const evSafe = isNaN(evNum) ? 0 : evNum;
        setExpectedVoters(evSafe);
        setExpectedVotersText(String(evSafe));
        setManualClosed(!!data.manualClosed);

        void patchPoll({
          title: data.title, desc: data.desc, voteLimit: data.voteLimit, options: data.options,
          ballots: data.ballots, anonymous: data.anonymous, visibilityMode: data.visibilityMode,
          authMode: data.authMode || "open", voterList: data.voterList || [],
          deadlineAt: data.deadlineAt ?? null, expectedVoters: evSafe, manualClosed: !!data.manualClosed,
        });
        setLinkVersion((v) => v + 1);
        setSaveHint("JSON에서 불러왔어요.");
      } catch {
        alert("불러오기에 실패했어요. JSON 형식을 확인하세요.");
      }
    };
    reader.readAsText(file, "utf-8");
    e.target.value = "";
  };

  if (isBooting || !pollId) {
    return <div className="min-h-screen grid place-items-center text-gray-500 font-sans">초기화 중입니다…</div>;
  }

  if (viewMode === "admin" && !adminAuthed) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-white to-gray-50 flex items-center justify-center px-4 font-sans">
        <form 
          onSubmit={(e) => {
            e.preventDefault();
            if (pinInput === ADMIN_PIN) setAdminAuthed(true);
            else alert("비밀번호가 일치하지 않습니다.");
          }} 
          className="bg-white p-6 sm:p-8 rounded-3xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-gray-100 flex flex-col gap-4 max-w-sm w-full"
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="h-12 w-12 rounded-2xl bg-indigo-600 text-white grid place-items-center font-bold shadow-md">V</div>
            <h2 className="text-2xl font-extrabold text-gray-800 tracking-tight">관리자 접속</h2>
          </div>
          <p className="text-sm text-gray-500">설정된 관리자 비밀번호(PIN)를 입력하세요.</p>
          <input 
            type="password" 
            placeholder="비밀번호 입력" 
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            className="border border-gray-200 p-4 rounded-2xl outline-none focus:ring-2 focus:ring-indigo-500 text-base bg-gray-50 focus:bg-white transition-colors"
          />
          <button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white p-4 rounded-2xl font-bold shadow-md mt-2 transition-all active:scale-[0.98]">
            인증하기
          </button>
        </form>
      </div>
    );
  }

  /* ========= 📺 전자칠판(전체화면) 발표 모드 ========= */
  if (viewMode === "admin" && isFullscreen) {
    return (
      <div className="fixed inset-0 z-50 bg-[#111827] text-white flex flex-col font-sans overflow-hidden animate-fadeIn">
        <div className="flex justify-between items-center p-6 md:p-8">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 shrink-0 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white grid place-items-center font-bold text-xl shadow-lg">V</div>
            <div>
              <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight">{title}</h1>
              <p className="text-gray-400 mt-2 text-lg md:text-xl">{desc}</p>
            </div>
          </div>
          <button 
            onClick={() => setIsFullscreen(false)}
            className="p-3 bg-white/10 hover:bg-white/20 rounded-full transition-colors"
          >
            <svg fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-8 h-8">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 flex flex-col md:flex-row p-6 md:p-8 pt-0 gap-8 h-full min-h-0">
          <div className="w-full md:w-1/3 flex flex-col gap-6 shrink-0">
            <div className="bg-white/5 rounded-[2rem] p-8 flex flex-col items-center justify-center border border-white/10 flex-1">
              <h2 className="text-2xl font-bold mb-6 text-indigo-200">투표 참여하기</h2>
              <div className="bg-white p-6 rounded-3xl shadow-2xl mb-6">
                <QRCode value={studentLink} size={280} className="w-full max-w-[280px] h-auto" />
              </div>
              <p className="text-xl text-gray-300 font-medium">스마트폰 카메라로 스캔하세요!</p>
            </div>
            
            <div className="bg-white/5 rounded-[2rem] p-8 border border-white/10">
              <div className="flex items-end justify-between mb-4">
                <h3 className="text-2xl font-bold text-gray-200">투표 진행 현황</h3>
                <div className="text-4xl font-extrabold text-emerald-400">
                  {votedCount}<span className="text-2xl text-gray-500 font-medium ml-1">{expectedVoters > 0 ? `/ ${expectedVoters}명` : '명'}</span>
                </div>
              </div>
              <div className="w-full h-6 bg-gray-800 rounded-full overflow-hidden shadow-inner">
                <div 
                  className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-1000 ease-out rounded-full" 
                  style={{ width: `${expectedVoters ? Math.min(100, (votedCount / expectedVoters) * 100) : (votedCount > 0 ? 100 : 0)}%` }} 
                />
              </div>
              {isClosed && (
                <div className="mt-6 p-4 bg-rose-500/20 border border-rose-500/30 rounded-xl text-center text-rose-300 font-bold text-xl animate-pulse">
                  투표가 마감되었습니다!
                </div>
              )}
            </div>
          </div>

          <div className="w-full md:w-2/3 bg-white/5 rounded-[2rem] border border-white/10 p-8 flex flex-col min-h-0">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-indigo-200">실시간 결과 (총 {totalVotes}표)</h2>
            </div>
            <div className="flex-1 w-full min-h-0">
              {isVisibleAdmin ? ( // 💡 여기서 isVisible 대신 isVisibleAdmin으로 수정했습니다!
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={graphData} margin={{ top: 30, right: 10, bottom: 30, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.1} vertical={false} stroke="#FFFFFF" />
                    <XAxis
                      dataKey="name"
                      interval={0}
                      angle={0}
                      tick={{ fontSize: 18, fill: '#E5E7EB', fontFamily: "Inter, system-ui, sans-serif", fontWeight: 600 }}
                      axisLine={false}
                      tickLine={false}
                      dy={20}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fontSize: 16, fill: '#6B7280', fontFamily: "Inter, system-ui, sans-serif" }}
                      axisLine={false}
                      tickLine={false}
                      width={40}
                    />
                    <Bar
                      dataKey="votes"
                      radius={[12, 12, 0, 0]}
                      barSize={80}
                      isAnimationActive
                      animationDuration={1000}
                      animationEasing="ease-out"
                    >
                      {graphData.map((d: GraphDatum) => (
                        <Cell key={d._i} fill={COLORS[d._i % COLORS.length]} />
                      ))}
                      <LabelList
                        dataKey="votes"
                        position="top"
                        style={{ fontSize: 28, fill: '#FFFFFF', fontWeight: 800, fontFamily: "Inter, system-ui, sans-serif" }}
                        dy={-10}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-gray-400">
                   <svg className="w-24 h-24 mb-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                  <p className="text-3xl font-bold text-gray-500">결과 비공개 상태입니다</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
  /* ============================================== */

  return (
    <div className="min-h-screen bg-[#F9FAFB] text-gray-900 flex flex-col font-sans selection:bg-indigo-100 selection:text-indigo-900">
      <header className="sticky top-0 z-20 bg-white/80 backdrop-blur-md border-b border-gray-200/80 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3.5 w-full">
            <div className="h-10 w-10 shrink-0 rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-600 text-white grid place-items-center font-bold shadow-sm">V</div>
            <div className="min-w-0 flex-1">
              {viewMode === "admin" ? (
                <input
                  className="text-lg sm:text-xl font-bold text-gray-900 bg-transparent border-b border-transparent focus:border-indigo-400 outline-none px-1 rounded w-full truncate placeholder-gray-300"
                  value={title}
                  onChange={async (e: React.ChangeEvent<HTMLInputElement>) => {
                    const v = e.target.value;
                    setTitle(v);
                    await patchPoll({ title: v });
                  }}
                  aria-label="제목"
                  placeholder="투표 제목을 입력하세요"
                />
              ) : (
                <div className="text-lg sm:text-xl font-bold text-gray-900 truncate px-1">{title}</div>
              )}
            </div>
          </div>

          {viewMode === "admin" ? (
            <div className="hidden sm:flex items-center gap-2 shrink-0">
              <button onClick={saveJSON} className="px-3.5 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm text-sm font-semibold transition-colors" disabled={isWorking}>JSON 저장</button>
              <button onClick={saveCSV} className="px-3.5 py-2 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 hover:border-gray-300 text-sm font-medium transition-colors text-gray-700" disabled={isWorking}>CSV 저장</button>
              <button onClick={() => fileInputRef.current?.click()} className="px-3.5 py-2 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 hover:border-gray-300 text-sm font-medium transition-colors text-gray-700" disabled={isWorking}>불러오기</button>
              <input ref={fileInputRef} type="file" accept="application/json" className="hidden" onChange={loadFromFile} />
            </div>
          ) : (
            <div className="text-xs font-semibold tracking-wide text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-full shrink-0 border border-indigo-100 hidden sm:block">학생 화면</div>
          )}
        </div>

        {viewMode === "admin" && (
          <div className="border-t border-gray-100 bg-white/50">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2.5 flex items-center gap-3 text-sm">
              <span className="px-3 py-1 rounded-full bg-white border border-gray-200 text-gray-700 font-semibold shadow-sm">투표 {votedCount}{expectedVoters > 0 ? `/${expectedVoters}` : ""}</span>
              {isClosed ? (
                <span className="px-3 py-1 rounded-full bg-rose-50 text-rose-700 border border-rose-200 font-semibold shadow-sm">마감됨</span>
              ) : (
                <span className="px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-semibold shadow-sm">진행중</span>
              )}
              <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden ml-2 max-w-xs shadow-inner">
                <div className="h-full bg-indigo-500 transition-all duration-500 rounded-full" style={{ width: `${expectedVoters ? Math.min(100, (votedCount / expectedVoters) * 100) : 0}%` }} />
              </div>
            </div>
          </div>
        )}
      </header>

      <div className="flex-1 w-full max-w-7xl mx-auto">
        {viewMode === "admin" ? (
          <AdminView
            {...{
              currentPid: pollId,
              allPolls,
              switchPoll,
              createNewPoll,
              deletePoll,
              togglePollStatus,
              desc,
              setDesc: async (v: string) => { setDesc(v); await patchPoll({ desc: v }); },
              voteLimit,
              setVoteLimit: async (v: VoteLimit) => { setVoteLimit(v); await patchPoll({ voteLimit: v }); },
              options, setOptionLabel, addOption, removeOption, recountVotes,
              ballots,
              anonymous, setAnonymous: async (b: boolean) => { setAnonymous(b); await patchPoll({ anonymous: b }); },
              visibilityMode,
              setVisibilityMode: async (m: Visibility) => { setVisibilityMode(m); await patchPoll({ visibilityMode: m }); },
              authMode,
              setAuthMode: async (m: AuthMode) => { setAuthMode(m); await patchPoll({ authMode: m }); },
              voterList,
              setVoterList: async (list: string[]) => { setVoterList(list); await patchPoll({ voterList: list }); },
              deadlineAt,
              setDeadlineAt: async (t: number | null) => { setDeadlineAt(t); await patchPoll({ deadlineAt: t }); },
              totalVotes, graphData, isVisible: isVisibleAdmin,
              expectedVotersText,
              onExpectedChange: async (e: React.ChangeEvent<HTMLInputElement>) => {
                const raw = e.target.value ?? "";
                setExpectedVotersText(raw);
                const num = raw.replace(/\D/g, "");
                const safe = num === "" ? 0 : parseInt(num, 10);
                setExpectedVoters(safe);
                await patchPoll({ expectedVoters: safe });
              },
              isClosed, closeNow, reopen,
              saveHint, saveToCloud,
              studentLink, copyStudentLink,
              showLink, setShowLink,
              resetAllToDefaults,
              removeVoter,
              isWorking,
              setIsFullscreen,
            }}
          />
        ) : (
          <StudentView
            {...{
              desc, options, voteLimit, anonymous,
              visibilityMode, authMode, voterList, deadlineAt, isVisible: isVisibleStudent,
              voterName, setVoterName, selected, setSelected, submitVote,
              totalVotes, graphData, isClosed,
              pidReady: !!pollId,
              isWorking,
            }}
          />
        )}
      </div>

      {viewMode === "admin" && (
        <footer className="w-full bg-white border-t border-gray-200 py-6 mt-auto">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 text-xs text-gray-400 flex flex-col sm:flex-row justify-between items-center gap-3">
            <span className="flex items-center gap-2">현재 방 ID: <span className="font-mono bg-gray-100 px-2 py-1 rounded-md text-gray-600 font-semibold tracking-wider">{pollId}</span></span>
            <span className="font-medium">Made for classroom by 교무</span>
          </div>
        </footer>
      )}
    </div>
  );
}

/* ========= Admin View ========= */
function AdminView(props: AdminViewProps) {
  const {
    currentPid, allPolls, switchPoll, createNewPoll, deletePoll, togglePollStatus,
    desc, setDesc,
    voteLimit, setVoteLimit,
    options, setOptionLabel, addOption, removeOption, recountVotes,
    ballots, anonymous, setAnonymous,
    visibilityMode, setVisibilityMode,
    authMode, setAuthMode, voterList, setVoterList,
    deadlineAt, setDeadlineAt,
    totalVotes, graphData, isVisible,
    expectedVotersText, onExpectedChange,
    isClosed, closeNow, reopen,
    saveHint, saveToCloud,
    studentLink, copyStudentLink,
    showLink, setShowLink,
    resetAllToDefaults,
    removeVoter,
    isWorking,
    setIsFullscreen
  } = props;

  const [activeTab, setActiveTab] = useState<'list' | 'settings' | 'results' | 'voters' | 'link'>('list');
  const [rosterInput, setRosterInput] = useState(voterList.join('\n'));

  useEffect(() => {
    setRosterInput(voterList.join('\n'));
  }, [voterList]);

  const handleRosterBlur = () => {
    const newList = rosterInput.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    setVoterList(newList);
  };

  const votedCount = Object.keys(ballots || {}).length;
  const ballotEntries: Array<[string, Ballot]> = Object.entries(ballots || {}) as any;

  const allPollsArray = useMemo(() => {
    return Object.entries(allPolls)
      .map(([pid, data]) => ({ pid, ...data }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }, [allPolls]);

  const getTabClass = (tabId: string) => {
    const isActive = activeTab === tabId;
    return `flex items-center gap-3 px-4 py-3 rounded-2xl transition-all font-semibold text-sm whitespace-nowrap cursor-pointer select-none ${
      isActive 
        ? 'bg-indigo-50 text-indigo-700 shadow-sm border border-indigo-100' 
        : 'text-gray-500 hover:bg-white hover:text-gray-800 hover:shadow-sm border border-transparent'
    }`;
  };

  return (
    <div className="flex flex-col md:flex-row gap-6 p-4 sm:p-6 w-full">
      <aside className="w-full md:w-56 shrink-0 md:sticky top-[100px] self-start z-10">
        <nav className="flex md:flex-col gap-2 overflow-x-auto pb-2 md:pb-0 hide-scrollbar scroll-smooth">
          <button onClick={() => setActiveTab('list')} className={getTabClass('list')}>
            <svg fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
            </svg>
            전체 투표 목록
          </button>
          
          <div className="hidden md:block my-2 border-t border-gray-200/60 mx-2"></div>

          <button onClick={() => setActiveTab('settings')} className={getTabClass('settings')}>
            <svg fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            현재 투표 설정
          </button>
          <button onClick={() => setActiveTab('results')} className={getTabClass('results')}>
            <svg fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
            </svg>
            실시간 결과 보기
          </button>
          <button onClick={() => setActiveTab('voters')} className={getTabClass('voters')}>
            <svg fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
            </svg>
            투표자 목록
          </button>
          <button onClick={() => setActiveTab('link')} className={getTabClass('link')}>
            <svg fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
            </svg>
            학생용 화면 링크
          </button>
        </nav>
      </aside>

      <main className="flex-1 min-w-0 pb-12">

        {activeTab === 'list' && (
          <div className="space-y-6 max-w-4xl animate-fadeIn">
            <div className="bg-white rounded-3xl shadow-[0_2px_10px_rgb(0,0,0,0.02)] border border-gray-100 p-6 sm:p-8">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-8 gap-4 border-b border-gray-100 pb-6">
                <div>
                  <h2 className="text-2xl font-bold text-gray-800">모든 투표 목록</h2>
                  <p className="text-sm text-gray-500 mt-1">총 {allPollsArray.length}개의 투표 방이 있습니다.</p>
                </div>
                <button 
                  onClick={async () => {
                    await createNewPoll();
                    setActiveTab('settings');
                  }} 
                  className="px-5 py-3 text-sm font-bold rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 shadow-md transition-all active:scale-95 flex items-center justify-center gap-2"
                  disabled={isWorking}
                >
                  <svg fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-5 h-5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                  새 투표 방 만들기
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {allPollsArray.map((pollData: any) => {
                  const p_votedCount = Object.keys(pollData.ballots || {}).length;
                  const p_expected = Number(pollData.expectedVoters || 0);
                  const p_autoClosed = p_expected > 0 && p_votedCount >= p_expected;
                  const p_isClosed = pollData.manualClosed || p_autoClosed;
                  const isActive = currentPid === pollData.pid;

                  return (
                    <div key={pollData.pid} className={`p-5 rounded-2xl border-2 transition-all group ${isActive ? 'border-indigo-500 bg-indigo-50/30 shadow-sm' : 'border-gray-200 hover:border-indigo-300 hover:shadow-md bg-white'}`}>
                      <div className="flex items-start justify-between mb-3 gap-2">
                        <div className="min-w-0">
                          <h3 className="font-bold text-lg text-gray-800 truncate" title={pollData.title || "제목 없음"}>
                            {pollData.title || "제목 없음"}
                          </h3>
                          <div className="text-xs text-gray-400 font-mono mt-1">ID: {pollData.pid}</div>
                        </div>
                        {p_isClosed ? (
                          <span className="shrink-0 px-2.5 py-1 rounded-lg bg-rose-50 text-rose-600 border border-rose-200 text-xs font-bold">마감됨</span>
                        ) : (
                          <span className="shrink-0 px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-600 border border-emerald-200 text-xs font-bold">진행중</span>
                        )}
                      </div>
                      
                      <div className="flex items-center gap-4 text-sm text-gray-600 mb-5">
                        <div className="flex items-center gap-1.5">
                          <svg fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-gray-400"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" /></svg>
                          <span className="font-semibold">{p_votedCount}명 참여</span>
                        </div>
                        <div className="text-xs text-gray-400">
                          {pollData.createdAt ? new Date(pollData.createdAt).toLocaleDateString() : '날짜 없음'}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 pt-4 border-t border-gray-100">
                        <button 
                          onClick={() => {
                            switchPoll(pollData.pid);
                            setActiveTab('settings');
                          }}
                          className={`flex-1 py-2 text-sm font-bold rounded-xl transition ${isActive ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-indigo-50 hover:text-indigo-700'}`}
                        >
                          {isActive ? '현재 관리중' : '관리(입장)'}
                        </button>
                        <button 
                          onClick={() => togglePollStatus(pollData.pid, pollData.manualClosed)}
                          className="px-3 py-2 text-sm font-semibold rounded-xl bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 transition"
                        >
                          {pollData.manualClosed ? '재개' : '마감'}
                        </button>
                        <button 
                          onClick={() => deletePoll(pollData.pid)}
                          className="px-3 py-2 text-sm font-semibold rounded-xl bg-white border border-rose-100 text-rose-500 hover:bg-rose-50 transition"
                        >
                          삭제
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
        
        {activeTab === 'settings' && (
          <div className="space-y-6 max-w-3xl animate-fadeIn">
            <div className="bg-white rounded-3xl shadow-[0_2px_10px_rgb(0,0,0,0.02)] border border-gray-100 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-gray-800 mb-5">현재 방 기본 설정</h2>
              <label className="text-sm font-semibold text-gray-700 block mb-2">투표 설명 안내문</label>
              <textarea
                value={desc}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDesc(e.target.value)}
                onFocus={() => { if (desc === DEFAULT_DESC) setDesc(""); }}
                className="w-full p-4 border border-gray-200 rounded-2xl outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 bg-gray-50 focus:bg-white transition-all text-sm sm:text-base leading-relaxed resize-none"
                rows={3}
                placeholder={DEFAULT_DESC}
              />

              <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-8 border-b border-gray-100 pb-8">
                <div className="space-y-5">
                  <div className="flex items-center justify-between p-1">
                    <span className="text-sm font-semibold text-gray-700">투표 방식</span>
                    <select
                      value={voteLimit}
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setVoteLimit(Number(e.target.value) as VoteLimit)}
                      className="border border-gray-200 rounded-xl px-4 py-2 text-sm sm:text-base bg-white focus:ring-2 focus:ring-indigo-500 outline-none font-medium text-gray-800 cursor-pointer"
                      disabled={isWorking}
                    >
                      <option value={1}>1인 1표</option>
                      <option value={2}>1인 2표</option>
                    </select>
                  </div>

                  <div className="flex items-center justify-between p-1">
                    <span className="text-sm font-semibold text-gray-700">익명 모드</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" className="sr-only peer" checked={anonymous} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAnonymous(e.target.checked)} disabled={isWorking} />
                      <div className="w-12 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-200 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                    </label>
                  </div>
                </div>

                <div className="space-y-5">
                  <div className="flex items-center justify-between p-1">
                    <span className="text-sm font-semibold text-gray-700">결과 공개 시점</span>
                    <select
                      value={visibilityMode}
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setVisibilityMode(e.target.value as Visibility)}
                      className="border border-gray-200 rounded-xl px-4 py-2 text-sm sm:text-base bg-white focus:ring-2 focus:ring-indigo-500 outline-none font-medium text-gray-800 cursor-pointer"
                      disabled={isWorking}
                    >
                      <option value="always">항상 공개</option>
                      <option value="hidden">항상 숨김</option>
                      <option value="deadline">마감 후 공개</option>
                    </select>
                  </div>

                  {visibilityMode === "deadline" && (
                    <div className="w-full pt-1">
                      <input
                        type="datetime-local"
                        className="border border-gray-200 rounded-xl px-4 py-2 text-sm sm:text-base w-full bg-white focus:ring-2 focus:ring-indigo-500 outline-none font-medium text-gray-800"
                        value={deadlineAt ? new Date(deadlineAt).toISOString().slice(0, 16) : ""}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDeadlineAt(e.target.value ? new Date(e.target.value).getTime() : null)}
                        disabled={isWorking}
                      />
                    </div>
                  )}

                  <div className="flex items-center justify-between p-1">
                    <div className="flex flex-col">
                      <span className="text-sm font-semibold text-gray-700">투표 인원 자동마감</span>
                      <span className="text-[11px] text-gray-400 font-medium mt-0.5">0 입력 시 자동마감 안함</span>
                    </div>
                    <input
                      type="text" inputMode="numeric" pattern="[0-9]*"
                      className="w-24 border border-gray-200 rounded-xl px-4 py-2 text-sm sm:text-base text-right bg-white focus:ring-2 focus:ring-indigo-500 outline-none font-bold text-gray-800"
                      value={expectedVotersText}
                      onChange={onExpectedChange}
                      placeholder="예: 25"
                      disabled={isWorking}
                    />
                  </div>
                </div>
              </div>

              <div className="mt-8 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-base font-bold text-gray-800">참여자 인증 방식 (신뢰성 강화)</span>
                    <span className="text-xs text-gray-500 mt-1">학생들이 장난으로 여러 번 투표하는 것을 방지합니다.</span>
                  </div>
                  <select
                    value={authMode}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setAuthMode(e.target.value as AuthMode)}
                    className="border border-indigo-200 rounded-xl px-4 py-2 text-sm sm:text-base bg-indigo-50 text-indigo-900 font-bold focus:ring-2 focus:ring-indigo-500 outline-none cursor-pointer"
                    disabled={isWorking}
                  >
                    <option value="open">누구나 참여 (기본)</option>
                    <option value="roster">명단 확인 (사전 등록만)</option>
                  </select>
                </div>
                
                {authMode === 'roster' && (
                  <div className="animate-fadeIn bg-gray-50 p-5 rounded-2xl border border-gray-200 mt-4">
                    <label className="text-sm font-semibold text-gray-700 block mb-2">
                      학급 명렬표 (이름 또는 번호 입력)
                    </label>
                    <textarea
                      placeholder="투표할 학생들의 이름이나 번호를 줄바꿈(Enter)이나 쉼표(,)로 구분해서 적어주세요.&#13;&#10;예) 1번, 2번, 3번... 또는 김철수, 홍길동..."
                      value={rosterInput}
                      onChange={(e) => setRosterInput(e.target.value)}
                      onBlur={handleRosterBlur}
                      className="w-full p-4 border border-gray-300 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 bg-white transition-all text-sm leading-relaxed"
                      rows={4}
                    />
                    <div className="mt-2 text-xs text-gray-500 flex justify-between px-1">
                      <span>* 입력 후 영역 바깥을 클릭하면 자동 저장됩니다.</span>
                      <span className="font-bold text-indigo-600">등록된 명단: {voterList.length}명</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-8 pt-5 border-t border-gray-100 flex items-center justify-between">
                <div className="text-sm font-medium text-gray-600 bg-gray-50 px-4 py-2 rounded-xl border border-gray-200">
                  참여: <span className="font-bold text-indigo-600">{votedCount}</span>명 <span className="mx-2 text-gray-300">|</span> 
                  총 표수: <span className="font-bold text-indigo-600">{totalVotes}</span>표
                </div>
                <div className="flex items-center gap-3">
                  {saveHint && <span className="text-sm text-emerald-600 font-bold bg-emerald-50 px-3 py-1.5 rounded-lg animate-pulse">{saveHint}</span>}
                  {!isClosed ? (
                    <button onClick={closeNow} className="px-5 py-2.5 text-sm font-bold rounded-xl bg-rose-50 text-rose-600 border border-rose-200 hover:bg-rose-100 hover:text-rose-700 transition-colors shadow-sm" disabled={isWorking}>방 수동 마감</button>
                  ) : (
                    <button onClick={reopen} className="px-5 py-2.5 text-sm font-bold rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-200 hover:bg-emerald-100 hover:text-emerald-700 transition-colors shadow-sm" disabled={isWorking}>방 투표 재개</button>
                  )}
                </div>
              </div>
            </div>

            <div className="bg-white rounded-3xl shadow-[0_2px_10px_rgb(0,0,0,0.02)] border border-gray-100 p-6 sm:p-8">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-6 gap-4">
                <h2 className="text-xl font-bold text-gray-800">보기 (항목) 설정</h2>
                <div className="flex items-center gap-2">
                  <button onClick={addOption} className="px-4 py-2.5 text-sm font-bold rounded-xl bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors" disabled={isWorking}>+ 항목 추가</button>
                  <button onClick={saveToCloud} className="px-5 py-2.5 text-sm font-bold rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm transition-all active:scale-95" disabled={isWorking}>변경사항 저장</button>
                </div>
              </div>
              
              <ul className="space-y-3">
                {options.map((o: Option, idx: number) => (
                  <li key={o.id} className="flex items-center gap-3 bg-white p-2.5 sm:p-3 rounded-2xl border border-gray-200 shadow-sm hover:border-indigo-300 hover:shadow-md transition-all group">
                    <span
                      className="h-8 w-8 shrink-0 rounded-xl shadow-inner ml-1"
                      style={{ backgroundColor: COLORS[idx % COLORS.length] }}
                    />
                    <input 
                      className="flex-1 bg-transparent border-none px-3 py-2 text-base font-medium text-gray-800 outline-none w-full min-w-0" 
                      value={o.label} 
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOptionLabel(o.id, e.target.value)} 
                      disabled={isWorking} 
                      placeholder={`보기 ${idx + 1}`}
                    />
                    <div className="flex items-center gap-3 shrink-0 pr-1">
                      <span className="text-sm font-bold text-gray-400 bg-gray-50 px-3 py-1.5 rounded-lg">{o.votes}표</span>
                      <button onClick={() => removeOption(o.id)} className="p-2 text-gray-400 hover:text-rose-500 hover:bg-rose-50 rounded-xl transition-colors" disabled={isWorking} aria-label="삭제">
                        <svg fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                        </svg>
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              
              <div className="mt-8 pt-5 border-t border-gray-100 flex items-center justify-between">
                <button onClick={resetAllToDefaults} className="px-5 py-2.5 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold text-sm transition-colors" disabled={isWorking}>전체 데이터 초기화 (위험)</button>
                <button onClick={recountVotes} className="px-5 py-2.5 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 font-bold text-sm shadow-sm transition-colors" disabled={isWorking}>투표수 갱신</button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'results' && (
          <div className="space-y-6 max-w-4xl animate-fadeIn">
            <div className="bg-white rounded-3xl shadow-[0_2px_10px_rgb(0,0,0,0.02)] border border-gray-100 p-6 sm:p-8 flex flex-col h-[550px]">
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-4">
                  <h2 className="text-xl font-bold text-gray-800">실시간 투표 결과</h2>
                  <div className="text-sm font-bold px-4 py-2 bg-indigo-50 text-indigo-700 rounded-xl border border-indigo-100 hidden sm:block">참여 {votedCount}명 · 총 {totalVotes}표</div>
                </div>
                <button 
                  onClick={() => setIsFullscreen(true)}
                  className="flex items-center gap-2 px-5 py-2.5 bg-gray-900 text-white rounded-xl text-sm font-bold shadow-md hover:bg-gray-800 hover:shadow-lg transition-all active:scale-95"
                >
                  <svg fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                  </svg>
                  <span className="hidden sm:inline">전자칠판 모드 열기</span>
                </button>
              </div>
              
              <div className="flex-1 w-full min-h-0">
                {isVisible ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={graphData} margin={{ top: 20, right: 10, bottom: 20, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.3} vertical={false} stroke="#9CA3AF" />
                      <XAxis
                        dataKey="name"
                        interval={0}
                        angle={-15}
                        textAnchor="end"
                        height={50}
                        tick={{ fontSize: 13, fill: '#4B5563', fontFamily: "Inter, system-ui, sans-serif", fontWeight: 500 }}
                        axisLine={false}
                        tickLine={false}
                        dy={10}
                      />
                      <YAxis
                        allowDecimals={false}
                        tick={{ fontSize: 13, fill: '#4B5563', fontFamily: "Inter, system-ui, sans-serif", fontWeight: 500 }}
                        axisLine={false}
                        tickLine={false}
                        width={40}
                      />
                      <Tooltip formatter={(v: number) => [`${v} 표`, '득표수']} cursor={{fill: '#F3F4F6', opacity: 0.5}} contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)', padding: '12px 16px', fontWeight: 'bold' }} />
                      <Bar
                        dataKey="votes"
                        radius={[8, 8, 0, 0]}
                        barSize={56}
                        isAnimationActive
                        animationDuration={700}
                        animationEasing="ease-out"
                      >
                        {graphData.map((d: GraphDatum) => (
                          <Cell key={d._i} fill={COLORS[d._i % COLORS.length]} />
                        ))}
                        <LabelList
                          dataKey="votes"
                          position="top"
                          style={{ fontSize: 15, fill: '#374151', fontWeight: 800, fontFamily: "Inter, system-ui, sans-serif" }}
                          dy={-5}
                        />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-gray-400 bg-gray-50 rounded-2xl border-2 border-dashed border-gray-200">
                    <svg className="w-14 h-14 mb-4 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                    <p className="font-bold text-gray-500">설정에 의해 결과가 비공개 상태입니다</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'voters' && (
          <div className="space-y-6 max-w-3xl animate-fadeIn">
            <div className="bg-white rounded-3xl shadow-[0_2px_10px_rgb(0,0,0,0.02)] border border-gray-100 p-6 sm:p-8">
              <div className="flex items-center justify-between mb-6 border-b border-gray-100 pb-5">
                <h2 className="text-xl font-bold text-gray-800">방 투표자 상세 목록</h2>
                <span className="text-sm font-bold px-4 py-1.5 bg-gray-100 rounded-xl text-gray-700">총 {ballotEntries.length}명 참여</span>
              </div>
              
              {ballotEntries.length === 0 ? (
                <div className="text-center py-16 bg-gray-50 rounded-2xl border-2 border-dashed border-gray-200">
                  <p className="text-gray-500 font-bold text-lg">아직 제출된 투표가 없습니다.</p>
                </div>
              ) : (
                <ul className="divide-y divide-gray-100 pr-2 max-h-[600px] overflow-y-auto custom-scrollbar">
                  {ballotEntries.map(([id, info]) => {
                    const displayName = (info as any).originalName || info?.name || '익명 투표자';
                    return (
                      <li key={id} className="flex items-center justify-between py-4 hover:bg-gray-50 px-4 rounded-2xl transition-colors group">
                        <div className="min-w-0 flex-1 pr-4">
                          <div className="font-bold text-gray-800 text-lg truncate flex items-center gap-2">
                            {displayName}
                            {anonymous && (info as any).originalName && (
                              <span className="px-2 py-0.5 bg-gray-200 text-gray-600 text-[10px] rounded-md font-bold">학생화면 익명</span>
                            )}
                          </div>
                          <div className="text-sm font-medium text-gray-400 mt-1">{new Date(info.at).toLocaleString()}</div>
                        </div>
                        <div className="flex items-center gap-4 shrink-0">
                          <div className="text-sm font-bold text-indigo-700 bg-indigo-50 border border-indigo-100 px-3 py-1.5 rounded-xl truncate max-w-[120px] sm:max-w-[200px]" title={(info.ids || []).join(", ")}>
                            {(info.ids || []).join(", ")}
                          </div>
                          <button onClick={() => removeVoter(id)} className="px-3 py-2 text-sm font-bold rounded-xl bg-white border border-gray-200 text-gray-500 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 shadow-sm transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100" disabled={isWorking}>
                            삭제
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}

        {activeTab === 'link' && (
          <div className="space-y-6 max-w-2xl animate-fadeIn">
            <div className="bg-white rounded-3xl shadow-[0_2px_10px_rgb(0,0,0,0.02)] border border-gray-100 p-6 sm:p-8">
              <div className="flex items-center justify-between mb-8 border-b border-gray-100 pb-5">
                <h2 className="text-xl font-bold text-gray-800">학생 공유용 주소 및 QR코드</h2>
                <div className="flex items-center gap-3">
                  <button onClick={() => setShowLink((v: boolean) => !v)} className="px-4 py-2.5 text-sm font-bold rounded-xl bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 shadow-sm transition-colors">{showLink ? "화면 숨기기" : "화면에 띄우기"}</button>
                  <a href={studentLink} target="_blank" rel="noreferrer" className="px-4 py-2.5 text-sm font-bold rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm transition-all active:scale-95">새 창으로 열기</a>
                </div>
              </div>
              
              <div className="flex flex-col items-center justify-center p-10 bg-gray-50 rounded-3xl border border-gray-100 mb-8">
                <div className="bg-white p-5 rounded-3xl shadow-md border border-gray-100 mb-6 transition-transform hover:scale-105">
                  <QRCode value={studentLink} size={220} className="w-full max-w-[220px] h-auto" />
                </div>
                <p className="text-base text-gray-600 font-bold text-center leading-relaxed">
                  학생들이 스마트폰 카메라로 QR코드를 스캔하면<br/>즉시 이 방의 투표 화면으로 이동합니다.
                </p>
              </div>

              <div className="space-y-4">
                <label className="text-sm font-bold text-gray-700">접속 링크 (URL)</label>
                {!showLink ? (
                  <div className="w-full text-base font-medium text-gray-500 bg-gray-100 border border-gray-200 rounded-2xl px-5 py-4 text-center cursor-not-allowed">
                    보안을 위해 주소가 숨겨져 있습니다. [화면에 띄우기]를 클릭하세요.
                  </div>
                ) : (
                  <div className="flex flex-col sm:flex-row gap-3">
                    <input 
                      value={studentLink} 
                      readOnly 
                      className="flex-1 text-base font-medium border-2 border-indigo-100 bg-indigo-50/50 text-indigo-900 rounded-2xl px-5 py-4 focus:outline-none focus:border-indigo-400 focus:bg-white transition-colors" 
                      onClick={(e) => e.currentTarget.select()} 
                    />
                    <button onClick={copyStudentLink} className="py-4 px-8 text-base font-bold rounded-2xl bg-indigo-600 text-white shadow-md hover:bg-indigo-700 hover:shadow-lg transition-all active:scale-95 whitespace-nowrap">
                      주소 복사하기
                    </button>
                  </div>
                )}
                {saveHint === "학생용 링크를 복사했어요." && (
                  <p className="text-sm text-emerald-600 font-bold text-right mt-2">{saveHint}</p>
                )}
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}

/* ========= Student View ========= */
function StudentView(props: StudentViewProps) {
  const {
    desc, options, voteLimit, anonymous,
    visibilityMode, authMode, voterList, deadlineAt, isVisible,
    voterName, setVoterName, selected, setSelected,
    submitVote, totalVotes, graphData, isClosed,
    pidReady, isWorking,
  } = props;

  const [submitted, setSubmitted] = useState(false);
  
  const onSubmit = async () => { 
    const success = await submitVote(); 
    if (success) {
      setSubmitted(true); 
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  return (
    <main className="max-w-3xl mx-auto px-4 py-6 md:py-10 space-y-6 md:space-y-8 font-sans">
      {!pidReady && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 p-5 rounded-2xl text-base font-bold text-center shadow-sm">
          방에 연결되지 않았습니다.<br className="sm:hidden" /> QR 코드나 링크로 다시 접속해 주세요.
        </div>
      )}

      <div className="bg-white rounded-[2rem] shadow-sm border border-gray-100 p-6 sm:p-8">
        <div className="text-sm font-extrabold text-indigo-600 mb-3 tracking-wide">안내사항</div>
        <div className="text-lg sm:text-xl whitespace-pre-wrap text-gray-800 leading-relaxed font-medium">{desc}</div>
      </div>

      <div className="bg-white rounded-[2rem] shadow-sm border border-gray-100 p-6 sm:p-8">
        {isClosed && (
          <div className="mb-6 p-5 rounded-2xl bg-rose-50 text-rose-700 text-base border border-rose-100 font-bold text-center flex flex-col items-center gap-2">
            <svg fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-8 h-8 text-rose-500">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
            </svg>
            투표가 마감되어 더 이상 제출할 수 없습니다.
          </div>
        )}

        {submitted && (
          <div className="mb-8 p-6 bg-emerald-50 border-2 border-emerald-100 rounded-2xl text-center flex flex-col items-center gap-3 animate-fadeIn">
            <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mb-1">
              <svg fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor" className="w-8 h-8">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <p className="text-xl font-extrabold text-emerald-800">투표가 성공적으로 제출되었습니다!</p>
            <p className="text-emerald-600 font-medium">참여해 주셔서 감사합니다.</p>
          </div>
        )}

        {(!anonymous || authMode === 'roster') && !submitted && (
          <div className="mb-8">
            <label className="flex flex-col sm:flex-row sm:items-end gap-2 text-base font-extrabold text-gray-800 mb-3">
              이름 또는 번호
              {anonymous && authMode === 'roster' && (
                <span className="text-sm font-bold text-rose-500 bg-rose-50 px-2 py-0.5 rounded">익명투표: 본인 확인용으로만 쓰입니다</span>
              )}
            </label>
            <input
              value={voterName}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setVoterName(e.target.value)}
              placeholder={authMode === 'roster' ? "선생님이 지정하신 정확한 이름(번호) 입력" : "여기에 입력하세요"}
              className="w-full border-2 border-gray-200 rounded-2xl px-5 py-4 text-lg font-medium outline-none focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 transition-all bg-gray-50 focus:bg-white placeholder-gray-400"
              disabled={isClosed || isWorking}
            />
          </div>
        )}

        {!submitted && (
          <>
            <div className="mb-4 flex items-center justify-between">
              <label className="text-base font-extrabold text-gray-800 flex items-center gap-2">
                항목 선택 
                <span className="text-sm font-bold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-lg">({selected.length}/{voteLimit})</span>
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {options.map((o: Option) => {
                const checked = selected.includes(o.id);
                const disabled = isClosed || isWorking || (!checked && selected.length >= voteLimit);
                return (
                  <button
                    key={o.id}
                    onClick={() =>
                      setSelected((prev: string[]) => {
                        if (isClosed || isWorking) return prev;
                        if (prev.includes(o.id)) return prev.filter((x: string) => x !== o.id);
                        if (prev.length >= voteLimit) return prev;
                        return [...prev, o.id];
                      })
                    }
                    className={`group relative flex items-center justify-between p-5 md:p-6 rounded-2xl border-2 transition-all duration-300 text-left w-full
                      ${checked 
                        ? "bg-indigo-50 border-indigo-500 shadow-[0_4px_20px_-4px_rgba(99,102,241,0.2)] transform scale-[1.02]" 
                        : "bg-white border-gray-200 hover:border-indigo-300 hover:bg-gray-50"} 
                      ${disabled && !checked ? "opacity-50 cursor-not-allowed bg-gray-50" : ""}
                    `}
                    disabled={disabled}
                  >
                    <span className={`font-bold text-lg sm:text-xl pr-8 ${checked ? "text-indigo-900" : "text-gray-800"}`}>
                      {o.label}
                    </span>
                    
                    <div className={`w-7 h-7 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors duration-300
                      ${checked ? "bg-indigo-600 border-indigo-600 text-white" : "border-gray-300 group-hover:border-indigo-400"}
                    `}>
                      {checked && (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="mt-10 flex justify-center">
              <button
                onClick={onSubmit}
                className={`w-full sm:w-auto min-w-[200px] px-10 py-4.5 rounded-2xl font-bold text-lg text-white shadow-lg transition-all duration-300
                  ${(isClosed || !pidReady || isWorking) ? "bg-gray-400 opacity-50 cursor-not-allowed shadow-none" : "bg-[#10B981] hover:bg-[#059669] hover:shadow-xl active:scale-95"}
                `}
                disabled={isClosed || !pidReady || isWorking}
              >
                투표 제출하기
              </button>
            </div>
          </>
        )}
      </div>

      <div className="bg-white rounded-[2rem] shadow-sm border border-gray-100 p-6 sm:p-8">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-xl font-extrabold text-gray-800">현재 결과</h2>
          {isVisible && <div className="text-sm font-bold px-4 py-2 bg-gray-100 rounded-xl text-gray-600">총 {totalVotes}표</div>}
        </div>
        
        <div className="w-full h-[280px] sm:h-[350px]">
          {isVisible ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={graphData} margin={{ top: 25, right: 10, bottom: 20, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} vertical={false} />
                <XAxis
                  dataKey="name"
                  interval={0}
                  angle={0}
                  tick={{ fontSize: 13, fill: '#4B5563', fontFamily: "Inter, system-ui, sans-serif", fontWeight: 600 }}
                  axisLine={false}
                  tickLine={false}
                  dy={15}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 13, fill: '#9CA3AF', fontFamily: "Inter, system-ui, sans-serif", fontWeight: 500 }}
                  axisLine={false}
                  tickLine={false}
                  width={30}
                />
                <Tooltip 
                  formatter={(v: number) => [`${v} 표`, '득표수']} 
                  cursor={{fill: '#F3F4F6', opacity: 0.6}}
                  contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 10px 25px -5px rgb(0 0 0 / 0.1)', padding: '12px 16px', fontWeight: 'bold' }} 
                />
                <Bar
                  dataKey="votes"
                  radius={[8, 8, 0, 0]}
                  barSize={48}
                  isAnimationActive
                  animationDuration={800}
                  animationEasing="ease-out"
                >
                  {graphData.map((d: GraphDatum) => (
                    <Cell key={d._i} fill={COLORS[d._i % COLORS.length]} />
                  ))}
                  <LabelList
                    dataKey="votes"
                    position="top"
                    style={{ fontSize: 16, fill: '#1F2937', fontWeight: 800, fontFamily: "Inter, system-ui, sans-serif" }}
                    dy={-5}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-gray-500 bg-gray-50 rounded-3xl border-2 border-dashed border-gray-200 p-6 text-center">
              {visibilityMode === "deadline" && deadlineAt ? (
                <>
                  <div className="w-16 h-16 bg-white shadow-sm rounded-2xl flex items-center justify-center mb-4">
                    <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div className="font-extrabold text-lg text-gray-700">결과는 마감 후 공개됩니다</div>
                  <div className="mt-3 text-sm font-bold text-gray-500 bg-white border border-gray-200 inline-flex px-4 py-2 rounded-xl shadow-sm">
                    공개 예정: {new Date(deadlineAt).toLocaleString()}
                  </div>
                </>
              ) : (
                <>
                  <div className="w-16 h-16 bg-white shadow-sm rounded-2xl flex items-center justify-center mb-4">
                    <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                  </div>
                  <div className="font-extrabold text-lg text-gray-700">현재 결과 비공개 상태입니다</div>
                  <p className="mt-2 text-sm font-medium text-gray-500">선생님(관리자) 설정에 의해 숨겨져 있습니다.</p>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
