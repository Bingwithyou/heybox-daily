import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONObject;
import com.github.unidbg.AndroidEmulator;
import com.github.unidbg.arm.backend.Unicorn2Factory;
import com.github.unidbg.file.FileResult;
import com.github.unidbg.linux.android.AndroidEmulatorBuilder;
import com.github.unidbg.linux.android.AndroidResolver;
import com.github.unidbg.linux.android.dvm.*;
import com.github.unidbg.linux.android.dvm.array.ByteArray;
import com.github.unidbg.linux.file.ByteArrayFileIO;
import com.github.unidbg.virtualmodule.android.AndroidModule;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Minimal Android environment for the JNI contract of APP 1.3.398. No network access. */
public final class NativeSigner extends AbstractJni implements AutoCloseable {
    private final AndroidEmulator emulator;
    private final VM vm;
    private final JSONObject request;
    private final DvmClass shader;
    private final DvmObject<?> context;

    private NativeSigner(Path assets, JSONObject request) throws Exception {
        this.request = request;
        emulator = AndroidEmulatorBuilder.for64Bit()
            .setProcessName("com.max.xiaoheihe")
            .setRootDir(Files.createTempDirectory("heybox-").toFile())
            .addBackendFactory(new Unicorn2Factory(true)).build();
        emulator.getMemory().setLibraryResolver(new AndroidResolver(23));
        emulator.getSyscallHandler().setEnableThreadDispatcher(true);
        // Match the descriptor range used after Android app startup.
        for (int fd = 0; fd < 24; fd++) emulator.getSyscallHandler().addFileIO(new ByteArrayFileIO(0, "/dev/null", new byte[0]));
        emulator.getSyscallHandler().addIOResolver((emu, file, flags) -> "/proc/self/status".equals(file)
            ? FileResult.success(new ByteArrayFileIO(flags, file,
                "Name:\tcom.max.xiaoheihe\nState:\tS (sleeping)\nTracerPid:\t0\n".getBytes(StandardCharsets.UTF_8))) : null);
        vm = emulator.createDalvikVM(assets.resolve("app-metadata.apk").toFile());
        vm.setJni(this);
        vm.setVerbose(false);
        new AndroidModule(emulator, vm).register(emulator.getMemory());
        context = vm.resolveClass("android/content/ContextWrapper", vm.resolveClass("android/content/Context")).newObject(null);
        for (String library : List.of("libnative-lib.so", "libglesv3_1.so")) {
            vm.loadLibrary(assets.resolve(library).toFile(), true).callJNI_OnLoad(emulator);
        }
        shader = vm.resolveClass("com/graphice/shaderar/ShaderManager");
        shader.callStaticJniMethod(emulator, "setParseDepth(Ljava/lang/String;Z)V", "/data/user/0/com.max.xiaoheihe/cache", true);
        shader.callStaticJniMethod(emulator, "setSecLevel()V");
        shader.callStaticJniMethod(emulator, "setHdrField([B)V", new ByteArray(vm, Files.readAllBytes(assets.resolve("shader-code.bin"))));
    }

    @Override public boolean acceptMethod(DvmClass type, String method, boolean isStatic) {
        return !"android/os/BatteryManager->isCharging()B".equals(method) && super.acceptMethod(type, method, isStatic);
    }
    @Override public int getStaticIntField(BaseVM vm, DvmClass type, String field) {
        if (Set.of("android/content/Context->MODE_PRIVATE:I", "android/content/ContextWrapper->MODE_PRIVATE:I").contains(field)) return 0;
        return super.getStaticIntField(vm, type, field);
    }
    @Override public DvmObject<?> callObjectMethodV(BaseVM vm, DvmObject<?> object, String method, VaList args) {
        if (method.equals("android/content/ContextWrapper->getSharedPreferences(Ljava/lang/String;I)Landroid/content/SharedPreferences;")) {
            return vm.resolveClass("android/content/SharedPreferences").newObject(null);
        }
        if (method.equals("android/content/SharedPreferences->getString(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;")
            && "DebugInfo".equals(args.getObjectArg(0).getValue())) return new StringObject(vm, request.getString("debugInfo"));
        return super.callObjectMethodV(vm, object, method, args);
    }
    private String stringCall(String method, Object... args) {
        DvmObject<?> result = shader.callStaticJniMethodObject(emulator, method, args);
        if (result == null || result.getValue() == null) throw new IllegalStateException("Native result missing");
        return result.getValue().toString();
    }
    private Map<String, String> sign() {
        String time = request.getString("time");
        String path = request.getString("path");
        String seed = stringCall("getChunkFlag(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;", context, "PAENEHAMGACOBHIEMIHIJLKJPMMHJMMQABCNGBPPENCENP");
        String nonce = stringCall("getIdxOffset(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", context, seed, time, request.getString("account"));
        String[][] inputs = {{"setViewport", time}, {"setGramLen", path}, {"setBuf", time},
            {"setDepRel", request.getString("model")}, {"setDLen", request.getString("osVersion")}, {"setPtrOffset", request.getString("version")}};
        for (String[] input : inputs) shader.callStaticJniMethod(emulator, input[0] + "(Ljava/lang/String;Ljava/lang/String;)V", input[1], nonce);
        vm.resolveClass("com/max/xiaoheihe/utils/NDKTools").callStaticJniMethodObject(emulator,
            "encode(Ljava/lang/Object;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", context, path, time, nonce);
        return Map.of("_time", time, "nonce", nonce,
            "hkey", stringCall("getObjType(Landroid/content/Context;Ljava/lang/String;Z)Ljava/lang/String;", context, nonce, false),
            "_rnd", request.getString("shaderVersion") + ":" + stringCall("getObjType(Landroid/content/Context;Ljava/lang/String;Z)Ljava/lang/String;", context, nonce, true));
    }
    @Override public void close() throws IOException { emulator.close(); }
    public static void main(String[] args) {
        try {
            String line = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8)).readLine();
            try (NativeSigner signer = new NativeSigner(Path.of(args[0]), JSON.parseObject(line))) {
                System.out.println(JSON.toJSONString(signer.sign()));
            }
        } catch (Exception error) {
            System.err.println("Native signer failed: " + error.getClass().getSimpleName());
            System.exit(1);
        }
    }
}
