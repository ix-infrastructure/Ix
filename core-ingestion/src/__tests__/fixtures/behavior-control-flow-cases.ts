// Copyright 2026 Ix Infrastructure Inc.
// Independent source labels. «name»...«/name» marks a UTF-16 source interval.
// The markers are removed before parsing. Each row names its own enclosing frames.
export interface FlowLabel {
  kind: 'while' | 'for' | 'try';
  construct: string;
  body: string;
  guardDepth: number;
  header?: string;
  test?: string | null;
  arm?: 'body' | 'catch' | 'finally';
  form?: 'catch' | 'finally' | 'catchFinally';
}
interface Site {
  assignment: string; slot: string; to: string | boolean;
  guards: [string, 'then' | 'else'][]; prior: string | boolean | null; frames: FlowLabel[];
}
export interface FlowCase { id: string; marked: string; owner: string; sites: Site[] }
const loop = (kind: 'while' | 'for', id: string, guardDepth: number, test: string | null): FlowLabel =>
  ({ kind, construct: id, body: id + 'Body', header: id + 'Header', test, guardDepth });
const arm = (id: string, form: FlowLabel['form'], branch: FlowLabel['arm'], depth = 0): FlowLabel =>
  ({ kind: 'try', construct: id, body: id + branch, form, arm: branch, guardDepth: depth });
const outer = arm('outer', 'catchFinally', 'body');
const nested = loop('while', 'repeat', 1, 'more');
const counted = loop('for', 'counted', 1, 'test');
const negative = (id: string, body: string): FlowCase => ({
  id, marked: 'class Task { run() {' + body + '} }', owner: 'Task.run', sites: [],
});

export const flowCases: FlowCase[] = [
  {
    id: 'CF-01/02/03 nested loops and exception arms', owner: 'Task.run',
    marked: `class Task { async run() {
      «outer»try «outerbody»{
        if («entry»this.status === "idle"«/entry») «repeat»«repeatHeader»while («more»more«/more»)«/repeatHeader» «repeatBody»{
          /*😀*/ «first»this.status = "busy"«/first»;
          «counted»«countedHeader»for (let i=0; «test»i<3«/test»; i++)«/countedHeader» «countedBody»{
            if («inner»this.phase === "open"«/inner») «second»this.phase = "done"«/second»;
            else «third»this.phase = "retry"«/third»;
          }«/countedBody»«/counted»
        }«/repeatBody»«/repeat»
      }«/outerbody» catch(err) «outercatch»{ await record(err); «caught»this.state="error"«/caught»; }«/outercatch»
      finally «outerfinally»{ «clean»this.status="closed"«/clean»; }«/outerfinally»«/outer»
    } }`.replaceAll('\n', '\r\n'),
    sites: [
      {assignment:'first',slot:'status',to:'busy',guards:[['entry','then']],prior:null,frames:[outer,nested]},
      {assignment:'second',slot:'phase',to:'done',guards:[['entry','then'],['inner','then']],prior:'open',frames:[outer,nested,counted]},
      {assignment:'third',slot:'phase',to:'retry',guards:[['entry','then'],['inner','else']],prior:null,frames:[outer,nested,counted]},
      {assignment:'caught',slot:'state',to:'error',guards:[],prior:null,frames:[arm('outer','catchFinally','catch')]},
      {assignment:'clean',slot:'status',to:'closed',guards:[],prior:null,frames:[arm('outer','catchFinally','finally')]},
    ],
  },
  {
    id:'CF-04 conditional cleanup after suspension', owner:'Pool.reset',
    marked:`class Pool { stopped=false; work(){if(this.stopped)return;tick()} async reset(){
      if(leave) return;
      «t»try «tbody»{ await pending; throw failure; }«/tbody» finally «tfinally»{
        «inside»try «insidebody»{ await work(); }«/insidebody» catch «insidecatch»{
          if («same»this.stopped === true«/same») «flip»this.stopped = false«/flip»;
          if («again»this.stopped === false«/again») { await work(); «late»this.stopped=true«/late»; }
        }«/insidecatch»«/inside»
      }«/tfinally»«/t»
    } }`,
    sites:[
      {assignment:'flip',slot:'stopped',to:false,guards:[['same','then']],prior:true,frames:[arm('t','finally','finally'),arm('inside','catch','catch')]},
      {assignment:'late',slot:'stopped',to:true,guards:[['again','then']],prior:null,frames:[arm('t','finally','finally'),arm('inside','catch','catch')]},
    ]
  },
  {
    id:'CF-01 headers and unbraced bodies',owner:'run',
    marked:`function run(){let state; «f»«fHeader»for (state="init";;state="update")«/fHeader» «fBody»«once»state="body"«/once»;«/fBody»«/f»
      «w»«wHeader»while («never»false«/never»)«/wHeader» «wBody»«zero»state="never"«/zero»;«/wBody»«/w»
      «h»«hHeader»for (;;)«/hHeader» «hBody»{if(a)break;if(b)continue;«tail»state="tail"«/tail»;}«/hBody»«/h»
    }`,
    sites:[
      {assignment:'once',slot:'state',to:'body',guards:[],prior:null,frames:[loop('for','f',0,null)]},
      {assignment:'zero',slot:'state',to:'never',guards:[],prior:null,frames:[loop('while','w',0,'never')]},
      {assignment:'tail',slot:'state',to:'tail',guards:[],prior:null,frames:[loop('for','h',0,null)]},
    ]
  },
  negative('CF-05 unsupported ancestors','for(const x of xs){try{this.state="of"}finally{}} do {while(a)this.status="do"}while(b); for(const x in xs)this.phase="in"; label: while(x)this.state="label"; switch(x){case 1:try{this.state="switch"}catch{}}'),
  negative('CF-05 wrong callable and receiver','while(x){later(()=>{this.state="cb"}); other.state="receiver";this["state"]="computed";}'),
  {id:'CF-05 async iteration',owner:'Task.run',marked:'class Task {async run(){for await(const x of xs){try{this.status="x"}finally{}}}}',sites:[]},
  {id:'CF-05 catch shadowing',owner:'run',marked:'function run(){let state;try{state="ambiguous"}catch(state){while(ready)state="shadow"}}',sites:[]},
];
