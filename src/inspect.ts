import { supabase } from "./lib/supabase";

async function run() {
  const { data, error } = await supabase.from('players').select('*').limit(1);
  console.log(JSON.stringify(data));
  console.log("Error:", error);
}
run();
